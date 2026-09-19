// worker/scripts/gen-keypair.mjs -- prints one Ed25519 keypair for licence
// signing. Run once, put the seed in the Worker as a secret, and paste the
// public key into whatever checks a key (the Mac app, verify-key.mjs).
//
// Created 2026-09-19 with the licence server. Node prints Ed25519 keys as DER
// (PKCS8 private, SPKI public); the raw 32 bytes we want are the tail of each,
// which is the shape WebCrypto and the Swift client both take.
//
//   node worker/scripts/gen-keypair.mjs
//   wrangler secret put LICENSE_SIGNING_KEY     # paste the seed
//
// The seed is the whole secret. Anyone holding it can mint licences, so it
// never goes in git, in a .dev.vars that gets committed, or in a chat message.
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

// Last 32 bytes of the PKCS8 DER is the seed; last 32 of the SPKI DER is the
// public key. Both headers are fixed-length for Ed25519, so the tail is exact.
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);

console.log(`LICENSE_SIGNING_KEY (private seed, base64):\n  ${seed.toString("base64")}\n`);
console.log(`public key (base64, safe to ship in the app):\n  ${pub.toString("base64")}`);
