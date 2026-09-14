# paw-mascot

A mascot on your desktop that reacts while Claude works. Idle when it is waiting, thinking when it is reasoning, working when it is editing files, a wink when it finishes, and a startle when it needs you.

The character is [paw-avatar](https://github.com/qbtrix/paw-fx) from paw-fx: twenty-eight states, a mood space, pointer tracking, and a drawing you can swap for your own. This repo is the two things around it — the bridge from Claude Code, and the window it lives in.

```
Claude Code ──hook──▶ paw-event.sh ──▶ ~/.paw/events.jsonl ──tail──▶ the pet
```

## Layout

```
plugin/     the Claude Code plugin: eleven hooks routed through one script
            that appends a line per event to ~/.paw/events.jsonl
web/        the pet page, the event→state mapping, and a dev server that
            tails the same file over SSE so all of it runs in a browser tab
app/        the Tauri shell: transparent always-on-top window, a tray item,
            and a Rust thread that tails the file into the page
tests/      the mapping, because it is the part that can be wrong
```

## The mapping is the product

`web/mapping.js` is a pure function of `(events, now)`: no DOM, no timers. It runs in Bun for the tests, in a browser tab for tuning, and in the Tauri webview for the app, and gives the same answer in all three. Rust that knew what "working" meant would be Rust that had to be rebuilt to change a timing, so Rust does not know.

Two ideas hold it together. A **state** is what the mascot is doing; a **reaction** is something that just happened — a failed tool is a flinch, then back to whatever it was doing, which is what stops it twitching on every event. And transient states carry a **hold**: `Stop` is a two-second wink, then idle. A wink that lasts until the next event is a mascot that got stuck.

The mood overlay is where the mood space earns its keep: arousal is the event rate over the last minute, so a busy session *looks* busy; attention is whether it is blocked on you.

## Run it in a tab first

```bash
bun run dev              # http://localhost:8799, tailing ~/.paw/events.jsonl
bun test                 # the mapping
```

Install the plugin in Claude Code, run a session in another terminal, and watch the tab. That is where the mapping gets tuned against real events, before there is a window to put it in.

## The app

```bash
bun run app:dev          # tauri dev (the effect is vendored; nothing to copy)
bun run app:build        # a .app and a .dmg
```

Needs Rust and the Tauri v2 CLI (`bunx @tauri-apps/cli@^2`). The window is 180px, frameless, transparent, always on top, on every workspace, and dragged by grabbing the mascot. The tray item shows and hides it, toggles always-on-top, and quits.

The Rust side is deliberately small: it tails the file on a 250ms poll — one small append-only file, one reader, and a poll behaves the same on every OS where filesystem watchers do not — and emits each line to the window as `paw://line`. The page cannot tell whether it is in the app or in a tab.

## The bridge

`plugin/hooks/paw-event.sh` is the whole of it. Claude Code hands it the hook payload on stdin; it appends one line with the bulky fields dropped and exits 0 no matter what, because a hook that fails can block Claude Code and a mascot is never a reason to block anything. `jq` if present, `python3` if not, and silence if neither.

## Licence

MIT.
