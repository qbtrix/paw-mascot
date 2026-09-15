# Harnesses: what each one reads, and what it can see

<!-- Created 2026-09-14 with the cross-harness slice. Facts checked against the
     official Codex hooks page and the Claude Code plugin docs that day; the
     DeepSeek Harness row comes from a source read on 2026-08-23 and is the one
     row here that has not been run end to end. -->

The mascot reads `~/.paw/events.jsonl`. `scripts/paw-event.sh` writes it. Every
harness below fires the same script; only the config file differs.

## Claude Code

- **Native path (preferred):** `/plugin marketplace add qbtrix/paw-mascot` then
  `/plugin install paw-mascot@paw-mascot`. The plugin carries
  `hooks/hooks.json` and Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}`.
- **Settings path (only if you skip the plugin):** merge into
  `~/.claude/settings.json` under `hooks`. `scripts/install.sh --claude-settings`
  does it.
- **Do not do both.** Two registrations mean two lines per event, which reads to
  the mascot as twice the activity.
- **Events:** all eleven the bridge knows.

## Codex CLI

- **Plugin (preferred):** `codex plugin marketplace add qbtrix/paw-mascot` then
  install `paw-mascot`. The repo carries a root `plugin/plugin.json` in the
  vendor-neutral [Agent Plugins](https://agent-plugins.org) format with an
  `extensions.com.openai` block pointing at `hooks/codex.json`, where it
  substitutes `${PLUGIN_ROOT}`.
- **Config (manual):** `~/.codex/hooks.json`, or `<repo>/.codex/hooks.json` for
  one project. Hooks are on by default; `[features] hooks = false` in
  `~/.codex/config.toml` turns them off.
- **Shape:** identical to Claude Code — a top-level `hooks` object, event names
  as keys, each a list of `{matcher, hooks: [{type: "command", command}]}`.
- **Payload:** identical field names too — `session_id`, `hook_event_name`,
  `tool_name`, `tool_input`, `cwd`. This is why the bridge needs no fork.
- **Events it has that we use:** SessionStart, SessionEnd, PreToolUse,
  PostToolUse, PermissionRequest, UserPromptSubmit, SubagentStart, SubagentStop,
  Stop.
- **Events it does not have:** `Notification` and `PostToolUseFailure`. So under
  Codex the mascot never shows the "waiting for you" state, and a failed tool
  reads as an ordinary one rather than a flinch. Everything else is the same.
- **Fires for:** shell, `apply_patch` (file edits), MCP tools and other local
  function tools — not shell only.

## DeepSeek Harness (dsh)

- dsh ships `packages/hooks/hooks-claude-code`, which runs an existing Claude
  Code `hooks.json` against its own interception points, including
  `${CLAUDE_PLUGIN_ROOT}` substitution. Pointing that at this bridge is the whole
  integration.
- **Unverified:** the exact config path dsh reads has not been run end to end.
  The installer prints guidance for dsh rather than guessing a path and writing
  to the wrong file. Its README calls the package "only a compatibility path", so
  treat this route as something that could change under us.

## Why two plugin manifests

Claude Code reads `.claude-plugin/plugin.json`. Codex reads a root `plugin.json`
in the Agent Plugins format. Anthropic is not on that spec's steering committee
(Amazon, Cursor, Microsoft, OpenAI and Vercel are), so there is no one file that
serves both, and this repo simply carries both. They share everything that
matters: one `paw-event.sh`, one event stream, one mascot.

The hooks files are separate for two reasons, not one. The obvious one is the
root variable -- `${CLAUDE_PLUGIN_ROOT}` against `${PLUGIN_ROOT}`. The other is
that Codex has no `Notification` or `PostToolUseFailure`, so its file declares
nine events where Claude's declares eleven. Listing an event a harness never
fires is harmless; listing one it rejects is not.

Which side gets the DEFAULT filename is deliberate. Both harnesses
auto-discover `hooks/hooks.json`, and both replace that discovery when the
manifest names a path -- but Claude Code additionally *warns* about the ignored
folder in `claude plugin list`, and that warning would greet every person who
installs this. So Claude gets the default name and no manifest key at all,
which cannot warn; Codex names `./hooks/codex.json` explicitly, which its docs
guarantee replaces discovery. The uncertainty sits where it is documented.

## Everything else

Cursor, Gemini CLI, OpenCode, GitHub Copilot, Amp, Goose and the rest support
the Agent Skills format, so this skill installs cleanly. None of them expose
lifecycle hooks, so none of them can tell the mascot anything. The skill says so
rather than failing in a way that looks fixable.

## When a line never arrives

1. `ls -l ~/.paw/events.jsonl` — missing means nothing has fired yet.
2. Check the harness's config actually contains the absolute path to
   `paw-event.sh`, and that the file is executable (`chmod +x`).
3. Run the bridge by hand — it should append one line and exit 0:
   ```bash
   echo '{"session_id":"test","hook_event_name":"SessionStart"}' | scripts/paw-event.sh
   tail -1 ~/.paw/events.jsonl
   ```
4. If that works but the harness still writes nothing, the harness is not firing
   hooks. For Codex, confirm `hooks` is not disabled in `config.toml`.

The bridge always exits 0, even when it cannot parse its input. A mascot is
never a reason to block an agent, so a broken bridge fails silently by design —
which is why step 3 checks it directly rather than trusting the absence of
errors.
