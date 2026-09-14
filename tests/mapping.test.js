// The mapping is the part that can be wrong, so it is the part with tests.
// Every case is a short event history and a clock, and the assertion is a
// state -- the same call the page makes, with no DOM in the way.
import { test, expect } from "bun:test";
import { derive, trim, parseLine, T } from "../web/mapping.js";

const ev = (event, ts, extra = {}) => ({ ts, session: "s", event, tool: null, notification: null, agent: null, ok: true, ...extra });

test("nothing has happened: idle, and no mood to speak of", () => {
  expect(derive([], 100).state).toBe("idle");
});

test("a tool says what kind of work it is", () => {
  expect(derive([ev("PreToolUse", 10, { tool: "Edit" })], 10).state).toBe("working");
  expect(derive([ev("PreToolUse", 10, { tool: "Bash" })], 10).state).toBe("focused");
  expect(derive([ev("PreToolUse", 10, { tool: "WebSearch" })], 10).state).toBe("curious");
  expect(derive([ev("PreToolUse", 10, { tool: "Grep" })], 10).state).toBe("thinking");
});

test("a tool state outlives its finish for a moment, then thinking", () => {
  const h = [ev("PostToolUse", 10, { tool: "Edit" })];
  expect(derive(h, 11).state).toBe("working");
  expect(derive(h, 10 + T.toolAfter + 1).state).toBe("thinking");
});

test("Stop is a wink that lets go", () => {
  // A wink that lasts until the next event is a mascot that got stuck.
  const h = [ev("Stop", 10)];
  expect(derive(h, 10.5).state).toBe("wink");
  expect(derive(h, 10 + T.wink + 0.1).state).toBe("idle");
});

test("a prompt is listened to, then thought about", () => {
  const h = [ev("UserPromptSubmit", 10)];
  expect(derive(h, 10.2).state).toBe("listening");
  expect(derive(h, 10 + T.listen + 0.1).state).toBe("thinking");
});

test("one failure is confusion; three inside a minute is annoyance", () => {
  const one = [ev("PostToolUseFailure", 10, { tool: "Bash", ok: false })];
  expect(derive(one, 10).state).toBe("confused");
  const three = [
    ev("PostToolUseFailure", 5, { ok: false }),
    ev("PostToolUseFailure", 8, { ok: false }),
    ev("PostToolUseFailure", 10, { ok: false })
  ];
  expect(derive(three, 10).state).toBe("annoyed");
  // and failures an hour apart do not add up
  const spread = [ev("PostToolUseFailure", 10, { ok: false }), ev("PostToolUseFailure", 3000, { ok: false }), ev("PostToolUseFailure", 6000, { ok: false })];
  expect(derive(spread, 6000).state).toBe("confused");
});

test("waiting on the reader is listening, with full attention", () => {
  const d = derive([ev("Notification", 10, { notification: "permission_prompt" })], 10);
  expect(d.state).toBe("listening");
  expect(d.mood.attention).toBe(1);
  expect(derive([ev("PermissionRequest", 10)], 10).state).toBe("listening");
});

test("a failure or a permission request is also a startle, once", () => {
  // The reaction rides on the event that caused it, and only while fresh.
  const h = [ev("PostToolUseFailure", 10, { ok: false })];
  expect(derive(h, 10.1).react).toBe("startle");
  expect(derive(h, 12).react).toBeNull();
});

test("subagents out means creative, until they are all back", () => {
  const out = [ev("SubagentStart", 10, { agent: "explore" })];
  expect(derive(out, 10).state).toBe("creative");
  const back = [...out, ev("SubagentStop", 20, { agent: "explore" }), ev("PreToolUse", 21, { tool: "Edit" })];
  expect(derive(back, 21).state).toBe("working");
});

test("a rate limit is gloomy, not attentive", () => {
  expect(derive([ev("Notification", 10, { notification: "quota_auto_resume_fired" })], 10).state).toBe("gloomy");
});

test("quiet long enough is sleep; the session ending is sleep at once", () => {
  expect(derive([ev("PostToolUse", 10, { tool: "Edit" })], 10 + T.idleToSleep + 1).state).toBe("sleeping");
  expect(derive([ev("SessionEnd", 10)], 10).state).toBe("sleeping");
});

test("arousal follows the event rate", () => {
  const quiet = [ev("PreToolUse", 10, { tool: "Edit" })];
  const busy = Array.from({ length: 25 }, (_, i) => ev("PreToolUse", 10 - i, { tool: "Edit" }));
  expect(derive(busy, 10).mood.arousal).toBeGreaterThan(derive(quiet, 10).mood.arousal);
});

test("trim keeps only what derive can still see", () => {
  const h = [ev("PreToolUse", 1), ev("PreToolUse", 2), ev("PreToolUse", 1000)];
  const kept = trim(h, 1000);
  expect(kept.length).toBe(1);
  expect(kept[0].ts).toBe(1000);
});

test("trim never drops the last event, however old", () => {
  // "Nothing for five minutes" is a fact about the last event's age. A trim
  // that discarded it left derive with an empty list, answering "idle" for a
  // session that had gone quiet -- and it read as a transport failure.
  const h = [ev("PreToolUse", 1), ev("PostToolUse", 2, { tool: "Edit" })];
  const kept = trim(h, 5000);
  expect(kept.length).toBe(1);
  expect(kept[0].ts).toBe(2);
  expect(derive(kept, 5000).state).toBe("sleeping");
});

test("a bad line is skipped rather than crashing the tail", () => {
  expect(parseLine("not json")).toBeNull();
  expect(parseLine('{"ts":"nope","event":"Stop"}')).toBeNull();
  expect(parseLine('{"ts":5,"event":"Stop"}')).toEqual({ ts: 5, event: "Stop" });
});
