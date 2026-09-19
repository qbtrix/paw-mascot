// worker/index.js — the only server-side code the site has: sign up for the
// founder list, confirm by email, and a count so the card's progress bar can
// show a real number instead of an invented one.
//
// Created 2026-09-15, replacing a "file a GitHub issue" pre-order link. That
// link asked a buyer for a GitHub account and then published their interest
// where anyone could read it, which is a strange thing to ask of someone
// trying to give you money.
//
// 2026-09-17: double opt-in. A signup now only saves the address and mails a
// confirm link; the seat counts once the link is opened. Before this, a bot
// could post fake addresses, fill the public bar and flip the card to the $29
// batch. A per-IP rate limit (SIGNUP_LIMIT) stops the endpoint being used to
// spam inboxes. Seats go in confirmation order, not signup order.
//
// Later on 2026-09-17: confirming now also mails a receipt (founder number, price, what
// happens next), and both emails are plain text with a greeting and signature.
//
// 2026-09-17: mail moved from Mailtrap to Cloudflare Email Service, which the
// Workers Paid plan already covers (3,000 a month). It sends from the
// mail.pocketpaw.xyz subdomain so bounces and any spam complaints stay off
// the main domain.
//
// 2026-09-19: the licence server. Three routes under /api/license: checkout
// starts a Dodo Checkout Session, webhook mints a key on a paid payment and
// emails it, resend re-sends a key someone lost. Mint and webhook verification
// live in ./license.js. Test mode only so far -- the Dodo account is not
// verified, so nothing here has taken a real payment.
//
// Everything else on this site is a static asset. Cloudflare serves assets
// first and only calls this Worker when nothing matches, so every page keeps
// being served exactly as it was before this file existed.
import { mintKey, verifyWebhook } from "./license.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Deliberately loose. The job is to catch a typo and a bot, not to adjudicate
// RFC 5322 -- a real address that this rejects is a lost sale, and the only
// proof an address works is mail arriving at it (which is now the confirm).
const looksLikeEmail = (s) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) && s.length <= 254;

// Sends one plain-text email through Cloudflare Email Service (the EMAIL
// binding). Local dev sets MAIL_DEV and only logs it, so testing never mails
// anyone. Fails loud: without the binding it throws rather than pretending a
// mail went out. Replies go to paw@pocketpaw.xyz, which Email Routing forwards.
async function sendMail(env, to, { subject, text }) {
  if (env.MAIL_DEV) {
    console.log(`[MAIL_DEV] to ${to}: ${subject}\n${text}`);
    return;
  }
  if (!env.EMAIL) throw new Error("mail not configured");
  await env.EMAIL.send({
    from: { email: env.MAIL_FROM || "paw@mail.pocketpaw.xyz", name: "Paw" },
    replyTo: "paw@pocketpaw.xyz",
    to,
    subject,
    text
  });
}

const SIGNATURE = "Prakash\nPaw, pet.pocketpaw.xyz\n";

const confirmMail = (link) => ({
  subject: "Confirm your Paw Pro founder spot",
  text:
    "Hi there,\n\n" +
    "Thanks for locking in the Paw Pro founder price.\n\n" +
    "Please confirm your email to hold your spot:\n" +
    `${link}\n\n` +
    "Nothing is charged today. Once you confirm, you will get a short receipt, and one more email when checkout opens.\n\n" +
    "If you did not request this, you can ignore this email.\n\n" +
    SIGNATURE
});

// Seats 1-250 are $19, the next 200 are $29, the same ladder the card shows.
const priceFor = (n) => (n <= 250 ? "$19" : n <= 450 ? "$29" : null);

const receiptMail = (n) => {
  const price = priceFor(n);
  return {
    subject: `You're Paw Pro founder #${n}`,
    text:
      "Hi there,\n\n" +
      "You're confirmed. Here are your details:\n\n" +
      `  Founder number:  #${n}\n` +
      (price ? `  Your price:      ${price}, lifetime\n` : "") +
      "  Charged today:   nothing\n\n" +
      "What happens next\n" +
      "Pro is being built as a native Mac app. When checkout opens, we will send one email with your link to buy" +
      (price ? " at this price" : "") + ".\n\n" +
      "Questions? Just reply to this email.\n\n" +
      SIGNATURE
  };
};

// True when this IP has run out of tries. Shared by every endpoint that can
// send mail, which is the thing worth throttling. The webhook is not throttled:
// it comes from Dodo, and dropping one loses a sale.
async function rateLimited(request, env) {
  if (!env.SIGNUP_LIMIT) return false;
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const { success } = await env.SIGNUP_LIMIT.limit({ key: ip });
  return !success;
}

async function signup(request, env, origin) {
  if (await rateLimited(request, env)) {
    return json({ error: "Too many tries. Wait a minute." }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Send JSON." }, 400); }

  // Honeypot: a field no human sees and every naive bot fills. Answering
  // with success is the point -- a bot told it failed comes back.
  if (body.website) return json({ ok: true });

  const email = String(body.email ?? "").trim().toLowerCase();
  if (!looksLikeEmail(email)) return json({ error: "That does not look like an email address." }, 400);

  let row;
  try {
    // The token is minted once and reused, so signing up twice resends the
    // same link and an older mail still works.
    row = await env.DB.prepare(
      `INSERT INTO preorders (email, created_at, source, token) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET email = email
       RETURNING token, confirmed_at`
    ).bind(email, new Date().toISOString(), String(body.source ?? "pro").slice(0, 40), crypto.randomUUID()).first();
  } catch {
    return json({ error: "Could not save that. Try again in a moment." }, 500);
  }
  if (row.confirmed_at) return json({ ok: true, state: "confirmed" });

  try {
    await sendMail(env, email, confirmMail(`${origin}/confirm?t=${row.token}`));
  } catch (err) {
    // Email Service throws with a code (E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED,
    // ...). Logged so `wrangler tail` says why; the address is left out.
    console.error("confirm mail failed:", err.code || "", err.message);
    return json({ error: "Could not send the confirm email. Try again in a moment." }, 500);
  }
  return json({ ok: true, state: "sent" });
}

// Opened from the email. Sets confirmed_at once, mails a receipt with the
// founder number, then sends the person back to the page with that number.
// The token never stays in the URL. A second open finds nothing to update,
// so the receipt goes out exactly once. The receipt is sent after the
// redirect (waitUntil), and a failed send never undoes the seat.
async function confirm(env, ctx, url) {
  const t = url.searchParams.get("t") || "";
  const back = (q) => Response.redirect(`${url.origin}/pro?confirmed=${q}`, 302);
  try {
    const now = new Date().toISOString();
    const row = await env.DB.prepare(
      "UPDATE preorders SET confirmed_at = ? WHERE token = ? AND confirmed_at IS NULL RETURNING email"
    ).bind(now, t).first();
    if (!row) return back("bad");
    const rank = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM preorders WHERE confirmed_at IS NOT NULL AND confirmed_at <= ?"
    ).bind(now).first();
    ctx.waitUntil(
      sendMail(env, row.email, receiptMail(rank.n)).catch((err) =>
        console.error("receipt mail failed:", err.code || "", err.message))
    );
    return back(rank.n);
  } catch {
    return back("bad");
  }
}

const licenseMail = (key, seat) => ({
  subject: `Your Paw Pro licence key (founder #${seat})`,
  text:
    "Hi there,\n\n" +
    "Thank you for buying Paw Pro. Here is your licence key:\n\n" +
    `${key}\n\n` +
    "Open Paw, go to Settings, and paste it into the Licence field.\n\n" +
    "Keep this email -- the key is tied to your purchase, not to a device. " +
    "If you lose it, ask for it again from the Pro page and we will send it back to this address.\n\n" +
    SIGNATURE
});

// Starts a Dodo Checkout Session and hands the browser the URL to go to.
// The API base comes from env so switching to live payments is a secret
// change, not a deploy of new code. Nothing here trusts the browser: the
// price and the product are ours, and the sale is only real once the webhook
// says so.
async function checkout(request, env, origin) {
  if (await rateLimited(request, env)) {
    return json({ error: "Too many tries. Wait a minute." }, 429);
  }
  if (!env.DODO_API_KEY || !env.DODO_PRODUCT_ID) {
    console.error("checkout: DODO_API_KEY or DODO_PRODUCT_ID not set");
    return json({ error: "Checkout is not open yet." }, 503);
  }

  let body = {};
  try { body = await request.json(); } catch { /* email is optional, prefill only */ }
  const email = String(body.email ?? "").trim().toLowerCase();

  try {
    const res = await fetch(`${env.DODO_API_BASE || "https://test.dodopayments.com"}/checkouts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.DODO_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        product_cart: [{ product_id: env.DODO_PRODUCT_ID, quantity: 1 }],
        // Prefilled only when it looks like an address; a typo here would
        // strand the buyer on a checkout page they cannot correct.
        ...(looksLikeEmail(email) ? { customer: { email } } : {}),
        // Read back in the webhook, so a payment for some other product on
        // this account can never mint a Pro licence.
        metadata: { plan: "founder" },
        return_url: `${origin}/pro?paid=1`
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.checkout_url) {
      console.error("checkout failed:", res.status, JSON.stringify(data).slice(0, 300));
      return json({ error: "Could not start checkout. Try again in a moment." }, 500);
    }
    return json({ url: data.checkout_url });
  } catch (err) {
    console.error("checkout error:", err.message);
    return json({ error: "Could not start checkout. Try again in a moment." }, 500);
  }
}

// Dodo calls this. It is the only thing that decides a sale happened -- the
// return_url redirect proves nothing, since anyone can visit it.
//
// Idempotent on payment_id: Dodo retries until it gets a 200, so the same
// payment can arrive several times, and the INSERT simply finds nothing to do
// on the second one. The mail goes out after the row is safely written.
async function webhook(request, env, ctx) {
  const raw = await request.text();
  if (!(await verifyWebhook(env.DODO_WEBHOOK_SECRET, request.headers, raw))) {
    return json({ error: "Bad signature" }, 401);
  }

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: "Send JSON." }, 400); }

  // Anything else is acknowledged and ignored: a 200 stops Dodo retrying an
  // event we were never going to act on.
  if (event.type !== "payment.succeeded") return json({ received: true });

  const data = event.data || {};
  const forPro =
    data.metadata?.plan === "founder" ||
    (data.product_cart || []).some((p) => p.product_id === env.DODO_PRODUCT_ID);
  if (!forPro) return json({ received: true });

  const email = String(data.customer?.email ?? "").trim().toLowerCase();
  const paymentId = String(data.payment_id ?? "");
  if (!paymentId || !looksLikeEmail(email)) {
    console.error("webhook: payment.succeeded without a usable payment_id or email");
    return json({ error: "Unusable payload" }, 400);
  }

  let row;
  try {
    // One statement: the seat is counted inside the insert, so two webhooks
    // landing together cannot both read the same count. seat is UNIQUE, so if
    // they somehow do, one fails and Dodo retries it. A repeat delivery of the
    // same payment conflicts on the primary key and returns nothing.
    row = await env.DB.prepare(
      `INSERT INTO licenses (payment_id, email, seat, key_id, created_at)
       VALUES (?, ?, (SELECT COUNT(*) + 1 FROM licenses), '', ?)
       ON CONFLICT(payment_id) DO NOTHING
       RETURNING seat`
    ).bind(paymentId, email, new Date().toISOString()).first();
  } catch (err) {
    // A 500 asks Dodo to retry, which is what we want: the buyer has paid.
    console.error("license insert failed:", err.message);
    return json({ error: "Could not record that." }, 500);
  }
  if (!row) return json({ received: true, state: "already-minted" });

  let key;
  try {
    key = await mintKey(env, row.seat);
    await env.DB.prepare("UPDATE licenses SET key_id = ? WHERE payment_id = ?")
      .bind(key, paymentId).run();
  } catch (err) {
    // The seat is taken but there is no key. Retrying would find the row and
    // do nothing, so this is loud: the captain mints by hand and resends.
    console.error("MINT FAILED for seat", row.seat, "--", err.message);
    return json({ error: "Could not mint." }, 500);
  }

  // Same shape as the confirm receipt: the mail is sent after the answer, and
  // a bounced email never un-sells the licence. Resend is the recovery path.
  ctx.waitUntil(
    sendMail(env, email, licenseMail(key, row.seat)).catch((err) =>
      console.error("licence mail failed:", err.code || "", err.message))
  );
  return json({ received: true, state: "minted" });
}

// "I lost my key." Always answers the same thing, whether or not the address
// bought anything, so this cannot be used to find out who is a customer. It
// also never reports a failure to the person: worst case they get no mail and
// ask again, which is better than a page that says try later and means it.
async function resend(request, env, ctx) {
  const generic = json({ ok: true, message: "If that address has a licence, the key is on its way." });
  if (await rateLimited(request, env)) {
    return json({ error: "Too many tries. Wait a minute." }, 429);
  }
  try {
    const body = await request.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!looksLikeEmail(email)) return generic;

    // Newest first: someone who bought twice gets their latest seat back.
    const row = await env.DB.prepare(
      "SELECT key_id, seat FROM licenses WHERE email = ? AND key_id != '' ORDER BY seat DESC LIMIT 1"
    ).bind(email).first();
    if (!row) return generic;

    ctx.waitUntil(
      sendMail(env, email, licenseMail(row.key_id, row.seat)).catch((err) =>
        console.error("resend mail failed:", err.code || "", err.message))
    );
  } catch (err) {
    console.error("resend failed:", err.message);
  }
  return generic;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    // The card's bar reads this. It counts confirmed signups only, so fake
    // or mistyped addresses never move it. If it is down, the page hides the bar.
    if (pathname === "/api/preorder/count") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      try {
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM preorders WHERE confirmed_at IS NOT NULL"
        ).first();
        return json({ count: row.c });
      } catch {
        return json({ error: "No counter yet." }, 500);
      }
    }
    if (pathname.startsWith("/api/license/")) {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (pathname === "/api/license/checkout") return checkout(request, env, url.origin);
      if (pathname === "/api/license/webhook") return webhook(request, env, ctx);
      if (pathname === "/api/license/resend") return resend(request, env, ctx);
      return new Response("Not found", { status: 404 });
    }
    if (pathname === "/confirm") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return confirm(env, ctx, url);
    }
    if (pathname !== "/api/preorder") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    return signup(request, env, url.origin);
  }
};
