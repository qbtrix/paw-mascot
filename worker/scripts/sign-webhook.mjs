// worker/scripts/sign-webhook.mjs -- signs a webhook body the way Dodo does,
// so the endpoint can be exercised locally without a tunnel or a real sale.
//
// Created 2026-09-19 with the licence server. It exists so local testing uses
// the real signature path instead of a bypass flag in the payment code.
//
//   node worker/scripts/sign-webhook.mjs '<json body>' <secret> [webhook-id]
//
// Prints a ready curl command. Pass the same webhook-id twice to prove the
// mint is idempotent.
import { createHmac, randomUUID } from "node:crypto";

const [body, secret, id = `evt_${randomUUID()}`] = process.argv.slice(2);
if (!body || !secret) {
  console.error("usage: node worker/scripts/sign-webhook.mjs '<json body>' <secret> [webhook-id]");
  process.exit(2);
}

const timestamp = String(Math.floor(Date.now() / 1000));
// Standard Webhooks: HMAC-SHA256 over "<id>.<timestamp>.<body>", with the
// secret's base64 part as the key bytes when it carries the whsec_ prefix.
const keyBytes = secret.startsWith("whsec_")
  ? Buffer.from(secret.slice(6), "base64")
  : Buffer.from(secret, "utf8");
const sig = createHmac("sha256", keyBytes).update(`${id}.${timestamp}.${body}`).digest("base64");

const url = process.env.WEBHOOK_URL || "http://127.0.0.1:4340/api/license/webhook";
console.log(
  `curl -s -X POST ${url} \\\n` +
  `  -H 'content-type: application/json' \\\n` +
  `  -H 'webhook-id: ${id}' \\\n` +
  `  -H 'webhook-timestamp: ${timestamp}' \\\n` +
  `  -H 'webhook-signature: v1,${sig}' \\\n` +
  `  -d '${body}'`
);
