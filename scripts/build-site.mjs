// build-site.mjs — assemble dist/site, the thing the Worker serves.
//
// Created 2026-09-15 with the landing page. The site is one static page plus
// the SAME vendored effect the app bundles, served at the same /_fx/ path, so
// the page and the app can never disagree about what the mascot looks like.
//
//   bun run site            -> dist/site
//   wrangler deploy         -> serves dist/site (see wrangler.toml)
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "dist/site");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "_fx/effects"), { recursive: true });

cpSync(join(ROOT, "site"), OUT, { recursive: true });
cpSync(join(ROOT, "web/_fx/effects/paw-avatar"), join(OUT, "_fx/effects/paw-avatar"), { recursive: true });
cpSync(join(ROOT, "app/src-tauri/icons/32x32.png"), join(OUT, "favicon.png"));

// Cloudflare serves these headers for static assets; long cache on the effect,
// none on the page, so a new deploy is seen immediately but the engine is not
// refetched on every visit.
const headers = `/_fx/*
  Cache-Control: public, max-age=31536000, immutable
/
  Cache-Control: no-cache
`;
await Bun.write(join(OUT, "_headers"), headers);

if (!existsSync(join(OUT, "index.html"))) throw new Error("site/index.html did not copy");
console.log(`site -> ${OUT} (${readdirSync(OUT).join(", ")})`);
