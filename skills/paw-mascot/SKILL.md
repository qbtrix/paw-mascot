---
name: paw-mascot
description: Installs the bridge that makes the Paw desktop mascot react while a coding agent works. Use when the user asks to set up, install, connect, or fix the Paw mascot, or wonders why the mascot on their desktop is not reacting to their session.
license: MIT
compatibility: macOS. Needs a harness with lifecycle hooks -- Claude Code, Codex CLI, or DeepSeek Harness. Needs jq or python3 on PATH. Installs into agents without hooks, but the mascot cannot see those sessions.
metadata:
  author: qbtrix
  version: "0.1.0"
  homepage: https://github.com/qbtrix/paw-mascot
---

# Paw mascot bridge

The Paw app is a mascot that sits on the desktop and reacts to what a coding
agent is doing: it works while tools run, flinches on a failure, and falls
asleep when nothing happens. It learns all of that from one file,
`~/.paw/events.jsonl`.

This skill installs the thing that writes that file.

## What this actually is

A skill is a prompt. It cannot observe tool calls. What the mascot needs is a
**hooks config**: the harness fires lifecycle events into a small shell script,
and the script appends one line per event. So this skill's job is not to *be*
the bridge, it is to *install* it into whichever harness you are running.

The script is the same everywhere. Codex uses the same hook payload fields as
Claude Code, so one bridge covers both.

## Setting it up

Run the installer. It looks for every harness it recognises, and reports what it
wrote and where:

```bash
scripts/install.sh
```

It is safe to run twice: it merges into existing config and never adds the same
hook entry a second time. Nothing needs sudo.

For **Claude Code**, prefer the native plugin over this script, because a plugin
and a settings entry both firing would double every event:

```
/plugin marketplace add qbtrix/paw-mascot
/plugin install paw-mascot@paw-mascot
```

The installer detects Claude Code and prints those two lines instead of editing
settings, unless you pass `--claude-settings` to force the settings route.

## Checking it worked

The installer appends one synthetic event on success, so a running mascot should
blink as it finishes. Otherwise:

```bash
tail -3 ~/.paw/events.jsonl
```

Run one command in your agent and look again. A new line means the bridge is
live. No new line means the harness is not firing hooks at the script -- see
`references/harnesses.md` for the config path each harness reads, and what to
check when a line never arrives.

## What will not work

A harness with no lifecycle hooks cannot drive the mascot. The skill installs
fine into Cursor, Gemini CLI, OpenCode, Copilot and the rest, and the mascot
will simply never hear from them. That is a limit of those harnesses, not a
misconfiguration, and no amount of retrying the installer changes it.

The app itself is a separate download:
[github.com/qbtrix/paw-mascot/releases](https://github.com/qbtrix/paw-mascot/releases).
The bridge writes the file whether or not the app is open, and the app catches
up from the tail when it starts.
