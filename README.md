# paw-mascot

A mascot on your desktop that reacts while your coding agent works. Idle when it is waiting, thinking when it is reasoning, working when it is editing files, a wink when it finishes, and a startle when it needs you.

The character is [paw-avatar](https://github.com/qbtrix/paw-fx) from paw-fx: twenty-eight states, a mood space, pointer tracking, and a drawing you can swap for your own. This repo is the two things around it — the bridge from the agent, and the window it lives in.

```
your agent ──hook──▶ paw-event.sh ──▶ ~/.paw/events.jsonl ──tail──▶ the pet
```

Works with **Claude Code** and **Codex CLI**. Anything that fires lifecycle hooks can drive it; anything that cannot, cannot (see [Which agents](#which-agents)).

## Install

macOS, Apple silicon or Intel. Two steps: get the app, then let it see your session.

**1. The app.** Download the `.dmg` from
[Releases](https://github.com/qbtrix/paw-mascot/releases/latest) and drag Paw to
Applications.

The first open, macOS will say *"Paw is damaged and can't be opened."* It is not
damaged. The build is not signed yet — that needs a paid Apple Developer
account, and this is a free mascot. Right-click the app and choose **Open**, and
the dialog offers to open it anyway. You only do this once. If you would rather
do it in one line:

```bash
xattr -d com.apple.quarantine /Applications/Paw.app
```

**2. The bridge.** The app reads `~/.paw/events.jsonl`. Something has to write it.

For **Claude Code**, inside a session:

```
/plugin marketplace add qbtrix/paw-mascot
/plugin install paw-mascot@paw-mascot
```

For **Codex CLI**:

```
codex plugin marketplace add qbtrix/paw-mascot
```

then install `paw-mascot` from it. Or, to set up several agents at once:

```bash
npx skills add qbtrix/paw-mascot
```

That prints where it installed the skill. Run the installer from there:

```bash
<that path>/scripts/install.sh
```

Or skip the skills CLI entirely — clone this repo and run
`skills/paw-mascot/scripts/install.sh`. The installer merges into whatever
config it finds, never clobbers what is already there, and is safe to run twice.
It needs `jq` or `python3`, which macOS has. Pass `--dry-run` to see what it
would write first.

Run one command in your agent. The mascot should react. If it does not,
`tail -3 ~/.paw/events.jsonl` — no new line means the bridge is not wired, and
`skills/paw-mascot/references/harnesses.md` walks through why.

## Which agents

| Agent | Works | Notes |
|-------|-------|-------|
| Claude Code | yes | all twelve events |
| Codex CLI | yes | ships as an [Agent Plugins](https://agent-plugins.org) package; no `Notification` or `PostToolUseFailure`, so no "waiting for you" and no flinch on a failed tool |
| DeepSeek Harness | probably | it runs a Claude Code `hooks.json` through a compatibility package; we have not run it end to end |
| Cursor, Gemini CLI, OpenCode, Copilot, … | no | the skill installs, but these have no lifecycle hooks, so the mascot never hears from them |

A mascot cannot watch an agent that does not tell it anything. That is a limit of
those agents, not a setting you can find.

## Layout

```
plugin/     the Claude Code plugin: twelve hooks routed through one script
            that appends a line per event to ~/.paw/events.jsonl
skills/     the same bridge as a portable Agent Skill, plus an installer that
            writes the right hooks config for whichever agent it lands in
web/        the pet page, the event→state mapping, and a dev server that
            tails the same file over SSE so all of it runs in a browser tab
app/        the Tauri shell: transparent always-on-top window, a tray item,
            and a Rust thread that tails the file into the page
tests/      the mapping, because it is the part that can be wrong
```

## The mapping is the product

`web/mapping.js` is a pure function of `(events, now)`: no DOM, no timers. It runs in Bun for the tests, in a browser tab for tuning, and in the Tauri webview for the app, and gives the same answer in all three. Rust that knew what "working" meant would be Rust that had to be rebuilt to change a timing, so Rust does not know.

Two ideas hold it together. A **state** is what the mascot is doing; a **reaction** is something that just happened — a failed tool is a flinch, then back to whatever it was doing, which is what stops it twitching on every event. And transient states carry a **hold**: `Stop` is a two-second wink, then idle. A wink that lasts until the next event is a mascot that got stuck.

Compaction gets the same care. `PreCompact` knocks the pet dizzy until that session comes back, which Claude Code announces as a `SessionStart` whose `source` is `compact`. If that never arrives, the spell ends after two minutes.

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

`skills/paw-mascot/scripts/paw-event.sh` is the whole of it. The agent hands it the hook payload on stdin; it appends one line with the bulky fields dropped and exits 0 no matter what, because a hook that fails can block the agent and a mascot is never a reason to block anything. `jq` if present, `python3` if not, and silence if neither.

Each line keeps `ts`, `session`, `event`, `tool`, `notification`, `agent`, `ok`, `cwd` and `transcript_path`, plus `source` when the payload has one (`SessionStart` says `startup`, `resume`, `clear` or `compact`). The events it is registered for are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Stop` and `SessionEnd`.

It needed no fork for Codex. Codex sends the same payload fields as Claude Code — `session_id`, `hook_event_name`, `tool_name` — and reads the same `hooks.json` shape, so one script covers both and only the config path differs.

The plugin carries a byte-identical copy at `plugin/hooks/paw-event.sh`, because Claude Code resolves `${CLAUDE_PLUGIN_ROOT}` against the plugin and a symlink does not survive every installer. `bun run sync-bridge` copies it across and a test fails if the two ever drift.

## Licence

Code MIT, art CC BY 4.0.

Every line of code here -- the engine, the app, the bridge, the site -- is
MIT, in [LICENSE](LICENSE). The Paw character itself, and the friends' heads
on the site, are Creative Commons BY 4.0, in [LICENSE-ART.md](LICENSE-ART.md):
use the art anywhere, commercially included, with visible credit -- "Paw
character by qbtrix", linked back here. The Paw name, and the character used
as a product's identity, stay the project's.
