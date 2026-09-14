# Vendored: the avatar effect

<!-- Created 2026-09-14 with the standalone split: records where these files come
     from, now that they are committed here instead of copied in at build time. -->

`effects/paw-avatar/` is a **copy** of the paw-avatar effect from
[paw-fx](https://github.com/qbtrix/paw-fx). It is committed here on purpose.

This repo used to read the effect out of a `../paw-fx` checkout sitting next to
it, which meant it only built on a machine that happened to have both repos
cloned side by side. A standalone app cannot ask that of anyone, so the effect
lives here now and `paw-mascot` builds with nothing beside it.

**paw-fx is still upstream.** These files are generated there (the character art
is baked into `index.js` by paw-fx's art pipeline) — don't hand-edit them, or the
next refresh will quietly overwrite your change. Fix it in paw-fx, then:

```bash
bun run sync-fx    # copies from ../paw-fx if that checkout exists; no-op if not
```

Two files, kept byte-identical to upstream so the refresh is a clean diff:

| file | what it is |
|------|-----------|
| `effects/paw-avatar/index.js` | the engine: states, mood space, the drawing |
| `effects/paw-avatar/style.css` | tokens only — no colours, so a host can theme it |
