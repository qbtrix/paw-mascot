#!/bin/bash
# install.sh — put the mascot bridge into whichever harness is on this machine.
#
# A skill is a prompt; it cannot observe tool calls. The mascot needs a hooks
# config, and every harness keeps that somewhere different. So this walks the
# ones we know, merges our entry into each, and says exactly what it wrote.
#
# Rules it follows:
#   - merge, never clobber. Existing hooks survive; ours is appended only if it
#     is not already there, so running this twice changes nothing the second time.
#   - back up before writing. <file>.paw-bak, once per run.
#   - never sudo, never touch anything outside $HOME.
#   - for Claude Code, print the plugin commands rather than editing settings:
#     a plugin AND a settings entry would both fire, and the mascot would see
#     every event twice. --claude-settings forces the settings route for people
#     who would rather not install a plugin.
#
#   ./install.sh [--claude-settings] [--dry-run]
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="$HERE/paw-event.sh"
CLAUDE_SETTINGS=0
DRY=0
for a in "$@"; do
  case "$a" in
    --claude-settings) CLAUDE_SETTINGS=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

if [ ! -f "$BRIDGE" ]; then
  echo "error: cannot find the bridge next to this script ($BRIDGE)" >&2
  exit 1
fi
chmod +x "$BRIDGE" 2>/dev/null || true

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is needed to merge JSON config safely." >&2
  echo "       The bridge itself only needs jq or python3; this installer needs python3." >&2
  echo "       Add the hooks by hand instead -- see references/harnesses.md." >&2
  exit 1
fi

# All eleven the bridge understands. Codex has no Notification or
# PostToolUseFailure, so it gets the subset it can actually fire.
CLAUDE_EVENTS="SessionStart UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure PermissionRequest Notification SubagentStart SubagentStop Stop SessionEnd"
CODEX_EVENTS="SessionStart UserPromptSubmit PreToolUse PostToolUse PermissionRequest SubagentStart SubagentStop Stop SessionEnd"

merge() { # merge <config-file> <events...>
  PAW_TARGET="$1"; shift
  PAW_EVENTS="$*"
  PAW_BRIDGE="$BRIDGE" PAW_DRY="$DRY" PAW_TARGET="$PAW_TARGET" PAW_EVENTS="$PAW_EVENTS" python3 <<'PY'
import json, os, shutil, sys

target = os.environ["PAW_TARGET"]
bridge = os.environ["PAW_BRIDGE"]
events = os.environ["PAW_EVENTS"].split()
dry    = os.environ["PAW_DRY"] == "1"

doc = {}
if os.path.exists(target):
    try:
        with open(target) as f:
            text = f.read().strip()
        doc = json.loads(text) if text else {}
    except Exception as e:
        print(f"  ! {target} is not valid JSON ({e}); leaving it alone")
        sys.exit(0)
if not isinstance(doc, dict):
    print(f"  ! {target} is not a JSON object; leaving it alone")
    sys.exit(0)

hooks = doc.setdefault("hooks", {})
if not isinstance(hooks, dict):
    print(f"  ! {target} has a 'hooks' key that is not an object; leaving it alone")
    sys.exit(0)

added, already = [], []
for ev in events:
    entries = hooks.setdefault(ev, [])
    if not isinstance(entries, list):
        print(f"  ! {ev} in {target} is not a list; skipping that event")
        continue
    mine = any(
        h.get("command") == bridge
        for e in entries if isinstance(e, dict)
        for h in e.get("hooks", []) if isinstance(h, dict)
    )
    if mine:
        already.append(ev)
    else:
        entries.append({"hooks": [{"type": "command", "command": bridge}]})
        added.append(ev)

if not added:
    print(f"  = {target}: already wired for {len(already)} events, nothing to do")
    sys.exit(0)

if dry:
    print(f"  ~ {target}: would add {len(added)} events ({', '.join(added)})")
    sys.exit(0)

os.makedirs(os.path.dirname(target), exist_ok=True)
if os.path.exists(target):
    shutil.copy2(target, target + ".paw-bak")
with open(target, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
note = f" ({len(already)} already present)" if already else ""
print(f"  + {target}: added {len(added)} events{note}")
PY
}

echo "Paw bridge: $BRIDGE"
[ "$DRY" = "1" ] && echo "(dry run -- nothing will be written)"
echo

FOUND=0

# --- Claude Code -------------------------------------------------------------
if [ -d "$HOME/.claude" ]; then
  FOUND=1
  echo "Claude Code:"
  if [ "$CLAUDE_SETTINGS" = "1" ]; then
    merge "$HOME/.claude/settings.json" $CLAUDE_EVENTS
  else
    echo "  the plugin is the better route here, so this script left settings alone."
    echo "  run these two inside Claude Code:"
    echo "    /plugin marketplace add qbtrix/paw-mascot"
    echo "    /plugin install paw-mascot@paw-mascot"
    echo "  (or re-run with --claude-settings to wire it up without a plugin)"
  fi
  echo
fi

# --- Codex CLI ---------------------------------------------------------------
if [ -d "$HOME/.codex" ]; then
  FOUND=1
  echo "Codex CLI:"
  merge "$HOME/.codex/hooks.json" $CODEX_EVENTS
  echo "  note: Codex has no Notification or PostToolUseFailure event, so the"
  echo "        mascot will not show 'waiting for you' or flinch on a failed tool."
  echo
fi

# --- DeepSeek Harness --------------------------------------------------------
if [ -d "$HOME/.dsh" ] || command -v dsh >/dev/null 2>&1; then
  FOUND=1
  echo "DeepSeek Harness:"
  echo "  dsh runs an existing Claude Code hooks.json through its"
  echo "  hooks-claude-code package. We have not verified which path it reads,"
  echo "  so nothing was written. Point that package at:"
  echo "    $BRIDGE"
  echo "  and see references/harnesses.md."
  echo
fi

if [ "$FOUND" = "0" ]; then
  echo "No harness with lifecycle hooks found (looked for ~/.claude, ~/.codex, dsh)."
  echo "The mascot can only react to a harness that fires hooks. See"
  echo "references/harnesses.md for the list."
  exit 0
fi

# One synthetic line, so a running mascot visibly blinks when this worked.
if [ "$DRY" = "0" ]; then
  PAW_DIR="${PAW_HOME:-$HOME/.paw}"
  mkdir -p "$PAW_DIR" 2>/dev/null || true
  printf '{"ts":%s,"session":"install","event":"SessionStart","ok":true}\n' \
    "$(date +%s)" >> "$PAW_DIR/events.jsonl" 2>/dev/null || true
  echo "Wrote one test event. A running mascot should have just reacted."
  echo "If it did not, check: tail -3 $PAW_DIR/events.jsonl"
fi
exit 0
