// build-site.mjs — assemble dist/site, the thing the Worker serves.
//
// Created 2026-09-15 with the landing page. The site is one static page plus
// the SAME vendored effect the app bundles, served at the same /_fx/ path, so
// the page and the app can never disagree about what the mascot looks like.
//
//   bun run site            -> dist/site
//   wrangler deploy         -> serves dist/site (see wrangler.toml)
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "dist/site");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "_fx/effects"), { recursive: true });

cpSync(join(ROOT, "site"), OUT, { recursive: true });
cpSync(join(ROOT, "web/_fx/effects/paw-avatar"), join(OUT, "_fx/effects/paw-avatar"), { recursive: true });
cpSync(join(ROOT, "app/src-tauri/icons/32x32.png"), join(OUT, "favicon.png"));
// The demo section drives a mascot with the SAME mapping the desktop app
// runs, so what the page shows is the product, not a re-enactment of it.
cpSync(join(ROOT, "web/mapping.js"), join(OUT, "mapping.js"));
// /pro must resolve on any static host without guessing its html_handling
// mood, so the page ships at both spellings: pro.html and pro/index.html.
mkdirSync(join(OUT, "pro"), { recursive: true });
cpSync(join(OUT, "pro.html"), join(OUT, "pro/index.html"));

// The effect is served immutable for a year, which is only safe if its URL
// changes when its bytes do. Without this, a reader who saw the page once
// keeps the engine they cached until 2027, and every fix we ship upstream
// quietly never reaches them. The hash goes in the query so the file itself
// stays at the path the app uses.
const fx = join(OUT, "_fx/effects/paw-avatar");
const stamp = createHash("sha256")
  .update(readFileSync(join(fx, "index.js")))
  .update(readFileSync(join(fx, "style.css")))
  .digest("hex")
  .slice(0, 8);
for (const page of ["index.html", "pro.html", "pro/index.html"]) {
  const at = join(OUT, page);
  writeFileSync(at, readFileSync(at, "utf8").replaceAll(
    /\/_fx\/effects\/paw-avatar\/(index\.js|style\.css)/g,
    `/_fx/effects/paw-avatar/$1?v=${stamp}`
  ));
}

// Cloudflare serves these headers for static assets; long cache on the effect,
// none on the page, so a new deploy is seen immediately but the engine is not
// refetched on every visit.
const headers = `/_fx/*
  Cache-Control: public, max-age=31536000, immutable
/friends/*
  Cache-Control: public, max-age=86400
/
  Cache-Control: no-cache
/pro
  Cache-Control: no-cache
`;
await Bun.write(join(OUT, "_headers"), headers);

if (!existsSync(join(OUT, "index.html"))) throw new Error("site/index.html did not copy");
console.log(`site -> ${OUT} (${readdirSync(OUT).join(", ")})`);
