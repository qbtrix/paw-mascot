// worker/scripts/verify-key.mjs -- checks a licence key against the public
// key. This is the reference verifier: the Swift client does the same four
// steps, so if this and the app ever disagree, this file is right.
//
// Created 2026-09-19 with the licence server.
//
//   node worker/scripts/verify-key.mjs <key> <public-key-base64>
//
// Exits 0 and prints the payload when the signature holds, 1 when it does not.
import { verify } from "node:crypto";

const [key, pubBase64] = process.argv.slice(2);
if (!key || !pubBase64) {
  console.error("usage: node worker/scripts/verify-key.mjs <key> <public-key-base64>");
  process.exit(2);
}

const [payloadPart, sigPart] = key.split(".");
if (!payloadPart || !sigPart) {
  console.error("not a licence key: expected <payload>.<signature>");
  process.exit(1);
}

const payload = Buffer.from(payloadPart, "base64url");
const sig = Buffer.from(sigPart, "base64url");

// Node wants a key object; the 12-byte SPKI header for Ed25519 is fixed, so
// the raw 32 bytes from gen-keypair.mjs become a DER key by prepending it.
const spki = Buffer.concat([
  Buffer.from("MCowBQYDK2VwAyEA", "base64"),
  Buffer.from(pubBase64, "base64")
]);

// The bytes verified are the ones carried in the key, never a re-serialised
// object -- that is what keeps this honest about what was actually signed.
const ok = verify(null, payload, { key: spki, format: "der", type: "spki" }, sig);

if (!ok) {
  console.error("SIGNATURE INVALID");
  process.exit(1);
}
console.log("signature OK");
console.log(payload.toString("utf8"));
