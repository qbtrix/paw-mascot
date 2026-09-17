// worker/index.js — the only server-side code the site has: one endpoint that
// writes a founder email into D1, and a count so the card's progress bar can
// show a real number instead of an invented one.
//
// Created 2026-09-15, replacing a "file a GitHub issue" pre-order link. That
// link asked a buyer for a GitHub account and then published their interest
// where anyone could read it, which is a strange thing to ask of someone
// trying to give you money.
//
// Everything else on this site is a static asset. Cloudflare serves assets
// first and only calls this Worker when nothing matches, so every page keeps
// being served exactly as it was before this file existed.
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Deliberately loose. The job is to catch a typo and a bot, not to adjudicate
// RFC 5322 -- a real address that this rejects is a lost sale, and the only
// proof an address works is mail arriving at it.
const looksLikeEmail = (s) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) && s.length <= 254;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // The card's bar reads this. It is the real row count, never a made-up
    // number: if this endpoint is missing or down, the page hides the bar.
    if (pathname === "/api/preorder/count") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      try {
        const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM preorders").first();
        return json({ count: row.c });
      } catch {
        return json({ error: "No counter yet." }, 500);
      }
    }
    if (pathname !== "/api/preorder") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    let body;
    try { body = await request.json(); } catch { return json({ error: "Send JSON." }, 400); }

    // Honeypot: a field no human sees and every naive bot fills. Answering
    // with success is the point -- a bot told it failed comes back.
    if (body.website) return json({ ok: true });

    const email = String(body.email ?? "").trim().toLowerCase();
    if (!looksLikeEmail(email)) return json({ error: "That does not look like an email address." }, 400);

    try {
      // INSERT OR IGNORE, so pressing the button twice is not an error and
      // the list never holds the same person twice.
      await env.DB.prepare(
        "INSERT OR IGNORE INTO preorders (email, created_at, source) VALUES (?, ?, ?)"
      ).bind(email, new Date().toISOString(), String(body.source ?? "pro").slice(0, 40)).run();
    } catch {
      return json({ error: "Could not save that. Try again in a moment." }, 500);
    }
    return json({ ok: true });
  }
};
