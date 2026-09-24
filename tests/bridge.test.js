// Changes: 2026-09-24 -- PreCompact passes through, and `source` is projected
// only when the payload has one.
// 2026-09-23 -- the bridge is now also RUN, once through jq and once
// through the python fallback, because the fallback had been writing nothing
// (its heredoc took over stdin) and no test ran it.
//
// The bridge ships twice -- once inside the skill, once inside the plugin --
// and Codex sends a narrower set of events than Claude Code does. Both of those
// are things that break quietly, so both get a test.
import { test, expect } from "bun:test";
import { readFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derive, T } from "../web/mapping.js";

const root = new URL("..", import.meta.url).pathname;
const ev = (event, ts, extra = {}) => ({ ts, session: "s", event, tool: null, notification: null, agent: null, ok: true, ...extra });

// --- running the bridge --------------------------------------------------------
// jq if the machine has it, python if not. Both paths get run: the python one
// under a PATH that holds python3 and the two commands the script needs, and
// nothing that could be jq.
const bridge = `${root}skills/paw-mascot/scripts/paw-event.sh`;
function pythonOnlyPath() {
  const bin = mkdtempSync(join(tmpdir(), "paw-bin-"));
  for (const c of ["python3", "date", "mkdir"]) symlinkSync(Bun.which(c), join(bin, c));
  return bin;
}
const BRANCHES = [
  ...(Bun.which("jq") ? [["jq", process.env.PATH]] : []),
  ...(Bun.which("python3") ? [["python3", pythonOnlyPath()]] : []),
];
function runBridge(PATH, ...payloads) {
  const home = mkdtempSync(join(tmpdir(), "paw-home-"));
  for (const p of payloads) {
    Bun.spawnSync(["/bin/bash", bridge], { stdin: Buffer.from(JSON.stringify(p)), env: { PATH, HOME: home, PAW_HOME: home } });
  }
  return readFileSync(join(home, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}
const LINE_KEYS = ["ts", "session", "event", "tool", "notification", "agent", "ok", "cwd", "transcript_path"];

test.each(BRANCHES)("the bridge writes one line per event through %s", (_, PATH) => {
  const [line] = runBridge(PATH, {
    session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Edit",
    tool_input: { file_path: "/x", content: "a whole file" }, cwd: "/w", transcript_path: "/t.jsonl",
  });
  expect(Object.keys(line)).toEqual(LINE_KEYS); // and never tool_input
  expect(line).toMatchObject({ session: "s1", event: "PreToolUse", tool: "Edit", ok: true, cwd: "/w" });
});

test.each(BRANCHES)("source rides along only when the payload has one, through %s", (_, PATH) => {
  // SessionStart says why the session started; "compact" is the one the pet
  // needs, to stop being dizzy. PreCompact has no source, and its line keeps
  // exactly the keys every other line has.
  const [pre, back] = runBridge(PATH,
    { session_id: "s1", hook_event_name: "PreCompact", trigger: "auto", custom_instructions: "" },
    { session_id: "s1", hook_event_name: "SessionStart", source: "compact" },
  );
  expect(pre.event).toBe("PreCompact");
  expect(Object.keys(pre)).toEqual(LINE_KEYS);
  expect(back).toMatchObject({ event: "SessionStart", source: "compact" });
  expect(Object.keys(back)).toEqual([...LINE_KEYS, "source"]);
});

// --- the two copies of the bridge --------------------------------------------
// skills/ is the source of truth, because that is what `npx skills add` installs.
// plugin/ needs its own copy because Claude Code resolves ${CLAUDE_PLUGIN_ROOT}
// against the plugin, and a symlink does not survive every installer. Two files
// with one meaning drift the moment someone edits the convenient one.
test("the plugin's bridge is identical to the skill's", () => {
  const a = readFileSync(`${root}skills/paw-mascot/scripts/paw-event.sh`, "utf8");
  const b = readFileSync(`${root}plugin/hooks/paw-event.sh`, "utf8");
  expect(b).toBe(a); // out of sync: run `bun run sync-bridge`
});

// --- Codex ---------------------------------------------------------------
// Codex fires the same payload shape as Claude Code but has no Notification and
// no PostToolUseFailure event. The mascot must still read a Codex session
// correctly rather than stalling on the states it can never reach.
const CODEX_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PermissionRequest", "SubagentStart", "SubagentStop", "Stop", "SessionEnd",
];

test("a Codex session still reads as work", () => {
  const h = [ev("SessionStart", 0), ev("UserPromptSubmit", 5), ev("PreToolUse", 10, { tool: "Edit" })];
  expect(derive(h, 10).state).toBe("working");
  expect(derive([...h, ev("PreToolUse", 12, { tool: "Bash" })], 12).state).toBe("focused");
});

test("a Codex session still goes quiet and then to sleep", () => {
  const h = [ev("SessionStart", 0), ev("Stop", 10)];
  expect(derive(h, 12).state).not.toBe("sleeping");
  expect(derive(h, 10 + T.idleToSleep + 1).state).toBe("sleeping");
  expect(derive([ev("SessionEnd", 10)], 11).state).toBe("sleeping");
});

test("every event Codex can send is one the mapping handles", () => {
  // Not that each produces a particular state -- only that none of them throws
  // and none of them lands the mascot on nothing at all.
  for (const name of CODEX_EVENTS) {
    const out = derive([ev(name, 10)], 10);
    expect(typeof out.state).toBe("string");
    expect(out.state.length).toBeGreaterThan(0);
  }
});

test("the two events Codex lacks are not load-bearing", () => {
  // If the mapping ever needs Notification or PostToolUseFailure to reach a
  // sensible state, Codex users get a stuck mascot. A stream without them must
  // still move.
  const claudeish = [ev("PreToolUse", 10, { tool: "Edit" }), ev("PostToolUse", 11, { tool: "Edit" })];
  expect(derive(claudeish, 11).state).toBeTruthy();
  expect(derive(claudeish, 11 + T.toolAfter + 1).state).toBeTruthy();
});
