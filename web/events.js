// events.js — where the event lines come from.
//
// Two sources, one shape: `subscribe(cb)` calls cb with each raw line of
// events.jsonl as it arrives. The page never learns which source it has.
//
// In the Tauri app the Rust side tails the file and emits "paw://line" to
// the window; in a browser tab dev-server.mjs does the same job over SSE.
// The seam is here on purpose: the mapping and the page are exercised in a
// tab for as long as the tuning takes, and nothing changes when the window
// is a real one.

export const isApp = typeof window !== "undefined" && !!window.__TAURI__;

export function subscribe(cb) {
  if (isApp) {
    // The app replays the tail on connect, so a session already in flight
    // is caught up rather than starting from "idle".
    window.__TAURI__.event.listen("paw://line", (ev) => cb(ev.payload));
    return;
  }
  const es = new EventSource("/events");
  es.onmessage = (m) => cb(m.data);
  es.onerror = () => {
    // EventSource reconnects on its own; nothing to do but not crash.
  };
}
