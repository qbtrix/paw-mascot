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
// spam inboxes. Seats go in confirmation order, not signup order. Mail goes
// through Mailtrap's sending API, the same provider pocketpaw's /growth uses.
//
// Everything else on this site is a static asset. Cloudflare serves assets
// first and only calls this Worker when nothing matches, so every page keeps
// being served exactly as it was before this file existed.
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Deliberately loose. The job is to catch a typo and a bot, not to adjudicate
// RFC 5322 -- a real address that this rejects is a lost sale, and the only
// proof an address works is mail arriving at it (which is now the confirm).
const looksLikeEmail = (s) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) && s.length <= 254;

// Sends the confirm link. Fails loud: without a key, and outside local dev,
// it throws rather than pretending a mail went out.
async function sendConfirm(env, email, link) {
  if (!env.MAILTRAP_API_TOKEN) {
    if (!env.MAIL_DEV) throw new Error("mail not configured");
    console.log(`[MAIL_DEV] confirm link for ${email}: ${link}`);
    return;
  }
  const res = await fetch("https://send.api.mailtrap.io/api/send", {
    method: "POST",
    headers: { "Api-Token": env.MAILTRAP_API_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      from: { email: env.MAIL_FROM || "paw@pet.pocketpaw.xyz", name: "Paw" },
      to: [{ email }],
      subject: "Confirm your Paw Pro founder spot",
      text: `Tap to lock your founder price:\n\n${link}\n\nIf you didn't ask for this, ignore it.\n`
    })
  });
  if (!res.ok) throw new Error(`mailtrap ${res.status}`);
}

async function signup(request, env, origin) {
  if (env.SIGNUP_LIMIT) {
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const { success } = await env.SIGNUP_LIMIT.limit({ key: ip });
    if (!success) return json({ error: "Too many tries. Wait a minute." }, 429);
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
    await sendConfirm(env, email, `${origin}/confirm?t=${row.token}`);
  } catch {
    return json({ error: "Could not send the confirm email. Try again in a moment." }, 500);
  }
  return json({ ok: true, state: "sent" });
}

// Opened from the email. Sets confirmed_at once, then sends the person back
// to the page with their founder number. The token never stays in the URL.
async function confirm(env, url) {
  const t = url.searchParams.get("t") || "";
  const back = (q) => Response.redirect(`${url.origin}/pro?confirmed=${q}`, 302);
  try {
    const now = new Date().toISOString();
    const res = await env.DB.prepare(
      "UPDATE preorders SET confirmed_at = ? WHERE token = ? AND confirmed_at IS NULL"
    ).bind(now, t).run();
    if (!res.meta.changes) return back("bad");
    const rank = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM preorders WHERE confirmed_at IS NOT NULL AND confirmed_at <= ?"
    ).bind(now).first();
    return back(rank.n);
  } catch {
    return back("bad");
  }
}

export default {
  async fetch(request, env) {
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
    if (pathname === "/confirm") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return confirm(env, url);
    }
    if (pathname !== "/api/preorder") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    return signup(request, env, url.origin);
  }
};
