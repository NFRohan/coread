/**
 * Web Push from a Worker with nothing but WebCrypto:
 *  - payload encryption: RFC 8291 (aes128gcm content coding, RFC 8188), one record;
 *  - sender identification: VAPID (RFC 8292), an ES256 JWT signed with our key pair.
 * Keys: VAPID_PUBLIC_KEY is the raw uncompressed P-256 point (base64url, 65 bytes);
 * VAPID_PRIVATE_KEY is the private scalar "d" (base64url, 32 bytes).
 */

const enc = new TextEncoder();

export function b64u(bytes: Uint8Array | ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export interface Subscription {
  endpoint: string;
  p256dh: string; // browser's public key, base64url
  auth: string;   // browser's auth secret, base64url
}

/** Encrypt a payload for one subscription (RFC 8291). Returns the request body. */
export async function encrypt(sub: Subscription, payload: Uint8Array): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("bad subscription keys");

  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The runtime takes the standard `public` member; workers-types spells it `$public`, hence the cast.
  const ecdh = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: payload followed by the 0x02 "last record" delimiter.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

const signingKeys = new Map<string, CryptoKey>(); // immutable imported key, reused across requests

async function vapidKey(pub: string, d: string): Promise<CryptoKey> {
  let k = signingKeys.get(pub);
  if (!k) {
    const raw = unb64u(pub);
    if (raw.length !== 65) throw new Error("VAPID_PUBLIC_KEY must be a raw P-256 point");
    const jwk = { kty: "EC", crv: "P-256", x: b64u(raw.slice(1, 33)), y: b64u(raw.slice(33, 65)), d, ext: false };
    k = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    signingKeys.set(pub, k);
  }
  return k;
}

/** VAPID Authorization header for a push service origin (RFC 8292). */
export async function vapidAuth(endpoint: string, pub: string, priv: string, subject: string, now: number): Promise<string> {
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: subject })));
  const unsigned = `${header}.${claims}`;
  // WebCrypto ECDSA signatures are already the raw r||s form JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidKey(pub, priv), enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${pub}`;
}
