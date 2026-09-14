#!/bin/bash
# paw-event.sh — the whole bridge between Claude Code and the mascot.
#
# Claude Code runs this on every hook event and hands the event as JSON on
# stdin. We append ONE line to ~/.paw/events.jsonl and get out of the way.
# The app tails that file. No port, no daemon, no socket: a file survives the
# app not being open yet, and the app can read back from the tail when it
# starts and catch up on a session already in flight.
#
# The line is the hook payload with the bulky fields dropped. tool_input can
# be an entire file's contents on a Write; the mascot does not need to know
# what you wrote, only that you wrote.
#
# Everything ends in `|| true`. A hook that fails can block Claude Code, and
# a mascot is never a reason to block anything.
set -u
PAW_DIR="${PAW_HOME:-$HOME/.paw}"
mkdir -p "$PAW_DIR" 2>/dev/null || exit 0

# jq if we have it, python if not, and nothing if neither -- silently.
if command -v jq >/dev/null 2>&1; then
  jq -c --arg ts "$(date +%s)" '{
    ts: ($ts | tonumber),
    session: .session_id,
    event: .hook_event_name,
    tool: .tool_name,
    notification: .notification_type,
    agent: .agent_type,
    ok: (if .hook_event_name == "PostToolUseFailure" then false else true end)
  }' >> "$PAW_DIR/events.jsonl" 2>/dev/null || true
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$PAW_DIR/events.jsonl" <<'PY' 2>/dev/null || true
import json, sys, time
try:
    p = json.load(sys.stdin)
except Exception:
    sys.exit(0)
line = {
    "ts": int(time.time()),
    "session": p.get("session_id"),
    "event": p.get("hook_event_name"),
    "tool": p.get("tool_name"),
    "notification": p.get("notification_type"),
    "agent": p.get("agent_type"),
    "ok": p.get("hook_event_name") != "PostToolUseFailure",
}
with open(sys.argv[1], "a") as f:
    f.write(json.dumps(line) + "\n")
PY
fi
exit 0
