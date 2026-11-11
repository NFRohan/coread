// Generate a Web Push (VAPID) key pair: `npm run vapid`.
// Paste the two lines into .dev.vars for local dev, or set them in production with `wrangler secret put`.
const { subtle } = globalThis.crypto;
const k = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const pub = Buffer.from(await subtle.exportKey("raw", k.publicKey)).toString("base64url");
const { d } = await subtle.exportKey("jwk", k.privateKey);
console.log(`VAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${d}`);
