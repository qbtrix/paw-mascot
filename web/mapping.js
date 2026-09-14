// mapping.js — hook events in, a mascot state out.
//
// This is the part that can be WRONG, which is why it is a pure function of
// (events, now) with no DOM and no timers: it runs in Bun for the tests, in a
// browser for the dev page, and in the Tauri webview for the app, and it
// gives the same answer in all three for the same input.
//
// Two ideas hold it together.
//
// 1. A STATE is what the mascot is doing; a REACTION is something that just
//    happened. "working" is a state. "a tool just failed" is a reaction: a
//    flinch, then back to whatever it was doing. Mixing them up is what makes
//    a mascot twitch on every event.
//
// 2. Transient states carry a HOLD. Stop -> wink is a two-second beat, then
//    idle; a wink that lasts until the next event is a mascot that got stuck.
//
// The mood overlay is where the space earns its keep: arousal is the event
// rate over the last minute, so a busy session LOOKS busy, and attention is
// whether it is blocked on you. Those are continuous; nothing here snaps
// between them.

/** Tools that mean "writing", "running", "looking things up", "reading". */
const WRITES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const RUNS = new Set(["Bash"]);
const LOOKS = new Set(["WebSearch", "WebFetch"]);
const READS = new Set(["Read", "Glob", "Grep", "LS"]);

/** Seconds. Named so the numbers can be argued about in one place. */
export const T = {
  wink: 2.0,          // Stop -> wink, then idle
  listen: 0.9,        // UserPromptSubmit -> listening, then thinking
  toolAfter: 4.0,     // a tool state outlives its PostToolUse by this much
  idleToSleep: 300,   // nothing for five minutes
  failWindow: 60,     // failures within this window count together
  failsToAnnoy: 3,
  rateWindow: 60      // arousal is events per this window
};

/** Something notable that happened at `ts`, as the mascot should take it. */
function reactionFor(e) {
  if (e.event === "PostToolUseFailure") return "startle";
  if (e.event === "PermissionRequest") return "startle";
  if (e.event === "Notification" && (e.notification === "permission_prompt" || e.notification === "agent_needs_input")) return "startle";
  return null;
}

/**
 * The state the mascot should be in at `now`, given what has happened.
 *
 * `events` is oldest-first. Only the tail matters; a caller keeps as much as
 * it likes and this walks back from the end.
 */
export function derive(events, now) {
  if (!events.length) return { state: "idle", mood: null, react: null, why: "no events" };

  const last = events[events.length - 1];
  const age = now - last.ts;

  // --- things that override everything ---------------------------------
  if (last.event === "SessionEnd") return out("sleeping", "session ended");
  if (age > T.idleToSleep) return out("sleeping", "nothing for five minutes");

  // rate limit: the one notification that means "wait", not "attend"
  if (last.event === "Notification" && /^quota_auto_resume/.test(last.notification ?? "")) {
    return out("gloomy", "rate limited");
  }

  // blocked on the reader: the pointer is not the only thing it attends to
  if (
    last.event === "PermissionRequest" ||
    (last.event === "Notification" &&
      (last.notification === "permission_prompt" || last.notification === "agent_needs_input" || last.notification === "idle_prompt"))
  ) {
    return out("listening", "waiting on you", { attention: 1 });
  }

  // --- transient beats, held for a moment then released ----------------
  if (last.event === "Stop") {
    return age < T.wink ? out("wink", "just finished") : out("idle", "finished a while ago");
  }
  if (last.event === "UserPromptSubmit") {
    return age < T.listen ? out("listening", "reading your prompt") : out("thinking", "on it");
  }

  // --- failures accumulate ----------------------------------------------
  const recentFails = events.filter((e) => e.event === "PostToolUseFailure" && now - e.ts < T.failWindow).length;
  if (last.event === "PostToolUseFailure") {
    return recentFails >= T.failsToAnnoy ? out("annoyed", `${recentFails} failures`) : out("confused", "a tool failed");
  }

  // --- subagents: creative while any are out ----------------------------
  const open = events.reduce((n, e) => (e.event === "SubagentStart" ? n + 1 : e.event === "SubagentStop" ? Math.max(0, n - 1) : n), 0);
  if (open > 0) return out("creative", `${open} subagent(s) out`);

  // --- tools -------------------------------------------------------------
  const toolState = (tool) =>
    WRITES.has(tool) ? "working" : RUNS.has(tool) ? "focused" : LOOKS.has(tool) ? "curious" : READS.has(tool) ? "thinking" : "working";
  if (last.event === "PreToolUse") return out(toolState(last.tool), `using ${last.tool}`);
  if (last.event === "PostToolUse") {
    return age < T.toolAfter ? out(toolState(last.tool), `finished ${last.tool}`) : out("thinking", "between tools");
  }

  if (last.event === "SessionStart") return out("excited", "session started");
  return out("idle", `no rule for ${last.event}`);

  function out(state, why, moodOver = {}) {
    // arousal is the event rate; attention is low while heads-down in tools
    const rate = events.filter((e) => now - e.ts < T.rateWindow).length / 30;
    const busy = state === "working" || state === "focused" || state === "thinking" || state === "curious";
    return {
      state,
      why,
      react: age < 0.5 ? reactionFor(last) : null,
      mood: {
        arousal: Math.min(1, 0.25 + rate),
        attention: busy ? 0.15 : 0.6,
        ...moodOver
      }
    };
  }
}

/**
 * Keep the last `windowSec` seconds of events and nothing older. The derive
 * walks from the tail, so the window only has to cover the longest lookback
 * (idleToSleep) and not the whole session.
 */
export function trim(events, now, windowSec = T.idleToSleep + 5) {
  const cut = now - windowSec;
  let i = 0;
  // The LAST event always survives, however old. "Nothing for five minutes"
  // is a fact about the last event's age, and a trim that discarded it left
  // derive looking at an empty list and answering "idle -- no events" for a
  // session that had gone quiet. That was the bug, and it hid behind a
  // transport error for a while.
  while (i < events.length - 1 && events[i].ts < cut) i++;
  return i ? events.slice(i) : events;
}

/** One line of events.jsonl -> an event, or null for a bad line. */
export function parseLine(line) {
  try {
    const e = JSON.parse(line);
    return typeof e.ts === "number" && typeof e.event === "string" ? e : null;
  } catch {
    return null;
  }
}
