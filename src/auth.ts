const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** MD5 is what KOReader-sync clients send as the "userkey"; Workers support it as a digest extension. */
export async function md5hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("MD5", enc.encode(s)));
}

export async function hashKey(salt: string, userkey: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(`${salt}:${userkey.toLowerCase()}`)));
}

export function newSalt(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

export async function checkUserkey(env: Env, username: string, userkey: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT key_hash, salt FROM users WHERE username = ?")
    .bind(username)
    .first<{ key_hash: string; salt: string }>();
  if (!row) return false;
  return safeEqual(await hashKey(row.salt, userkey), row.key_hash);
}

/** KOReader-sync auth: X-Auth-User / X-Auth-Key headers, or HTTP Basic (Readest's fallback). */
export async function syncUser(env: Env, req: Request): Promise<string | null> {
  let user = req.headers.get("x-auth-user");
  let key = req.headers.get("x-auth-key");
  const basic = req.headers.get("authorization");
  if ((!user || !key) && basic?.startsWith("Basic ")) {
    try {
      const decoded = new TextDecoder().decode(fromB64url(basic.slice(6).trim()));
      const i = decoded.indexOf(":");
      if (i > 0) {
        user = decoded.slice(0, i);
        key = await md5hex(decoded.slice(i + 1));
      }
    } catch {
      return null;
    }
  }
  if (!user || !key) return null;
  return (await checkUserkey(env, user, key)) ? user : null;
}

// ---- companion-page session cookie (HMAC-signed, HttpOnly) ----

const COOKIE = "coread_session";
const MAX_AGE = 90 * 24 * 3600;

async function hmacKey(env: Env): Promise<CryptoKey> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) throw new Error("SESSION_SECRET is missing or too short");
  return crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sessionCookie(env: Env, username: string, now: number): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ u: username, exp: now + MAX_AGE })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(payload)));
  return `${COOKIE}=${payload}.${b64url(sig)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function pageUser(env: Env, req: Request, now: number): Promise<string | null> {
  const cookie = req.headers.get("cookie") || "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie);
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64url(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { u?: unknown; exp?: unknown };
    if (typeof data.u !== "string" || typeof data.exp !== "number" || data.exp < now) return null;
    return data.u;
  } catch {
    return null;
  }
}
