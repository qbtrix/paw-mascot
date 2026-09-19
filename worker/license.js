// worker/license.js -- mints a Paw Pro licence key and verifies the Dodo
// webhook signature. Two small things the payment routes in index.js need,
// kept out of that file because both are fiddly byte work.
//
// Created 2026-09-19 with the licence routes.
//
// The key is a signed claim, not a lookup id: the Mac app checks it offline
// with the public key and never calls us. Shape (the Swift client is built
// against exactly this, so it does not change without changing both sides):
//
//   key     = base64url(payload_json) + "." + base64url(signature)
//   payload = {"v":1,"plan":"founder","seat":<int>,"iat":<unix>,"exp":0}
//   sig     = Ed25519 over the exact payload bytes, exp 0 meaning lifetime
//
// The payload string travels inside the key, so a verifier signature-checks
// the bytes it was given and never re-serialises the object -- key order or a
// stray space would change the bytes and break an otherwise valid key.
const b64urlEncode = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64Decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// WebCrypto will not import a bare 32-byte Ed25519 seed ("raw" is public keys
// only), so wrap it in the fixed PKCS8 header RFC 8410 defines. The header is
// constant for Ed25519, which is why this is a prepend and not a DER encoder.
const PKCS8_ED25519_HEADER = b64Decode("MC4CAQAwBQYDK2VwBCIEIA==");

async function signingKey(seedBase64) {
  const seed = b64Decode(seedBase64);
  if (seed.length !== 32) throw new Error("LICENSE_SIGNING_KEY must be a base64 32-byte seed");
  const pkcs8 = new Uint8Array(PKCS8_ED25519_HEADER.length + 32);
  pkcs8.set(PKCS8_ED25519_HEADER);
  pkcs8.set(seed, PKCS8_ED25519_HEADER.length);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

// Throws if LICENSE_SIGNING_KEY is missing or malformed. Deliberate: a licence
// that cannot be signed must not turn into a cheerful empty string in an email.
export async function mintKey(env, seat) {
  const payload = JSON.stringify({
    v: 1,
    plan: "founder",
    seat,
    iat: Math.floor(Date.now() / 1000),
    exp: 0
  });
  const bytes = new TextEncoder().encode(payload);
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    await signingKey(env.LICENSE_SIGNING_KEY || ""),
    bytes
  );
  return `${b64urlEncode(bytes)}.${b64urlEncode(new Uint8Array(sig))}`;
}

// Standard Webhooks (standardwebhooks.com), which is what Dodo signs with:
// HMAC-SHA256 over "<id>.<timestamp>.<raw body>", base64, and the header is a
// space-separated list of "v1,<sig>" so a secret rotation can carry two.
// The secret is whsec_<base64>; the base64 part decodes to the key bytes.
export async function verifyWebhook(secret, headers, rawBody) {
  const id = headers.get("webhook-id") || "";
  const timestamp = headers.get("webhook-timestamp") || "";
  const header = headers.get("webhook-signature") || "";
  if (!secret || !id || !timestamp || !header) return false;

  // Replay window. Checked before the HMAC so an old body is cheap to reject.
  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(skew) || skew > 300) return false;

  const keyBytes = secret.startsWith("whsec_")
    ? b64Decode(secret.slice(6))
    : new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);

  for (const part of header.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    try {
      // crypto.subtle.verify is constant-time, so no hand-rolled compare.
      if (await crypto.subtle.verify("HMAC", key, b64Decode(sig), signed)) return true;
    } catch {
      // A malformed base64 signature is just a failed attempt, not an error.
    }
  }
  return false;
}
