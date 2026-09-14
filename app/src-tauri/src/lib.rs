//! The shell. It does exactly three things and nothing else:
//!
//!   1. tail ~/.paw/events.jsonl and hand each new line to the window as
//!      the "paw://line" event -- the same lines dev-server.mjs sends over
//!      SSE, so the page cannot tell which host it is in;
//!   2. a tray item, which is where you find the pet when it is hidden;
//!   3. a transparent, frameless, always-on-top window for the page.
//!
//! The mapping from events to states is NOT here. It lives in web/mapping.js
//! where it can be tuned in a browser tab against a real session, and tested
//! in Bun with no window at all. Rust that knew what "working" meant would
//! be Rust that had to be rebuilt to change a timing.

use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

/// How many lines to replay on start, so a session already in flight is
/// caught up rather than beginning from "idle".
const REPLAY: usize = 200;
/// The tail is a poll, not a watcher. One small append-only file and one
/// reader: a 250ms poll is trivially cheap and behaves the same on every
/// OS, where filesystem watchers do not.
const POLL_MS: u64 = 250;

fn events_path() -> PathBuf {
    if let Ok(dir) = std::env::var("PAW_HOME") {
        return PathBuf::from(dir).join("events.jsonl");
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".paw").join("events.jsonl")
}

/// Follow the file forever, emitting each new line to the window.
fn tail(app: AppHandle) {
    let path = events_path();
    let mut offset: u64 = 0;

    // Replay the tail once so the mascot opens on the current state.
    if let Ok(text) = fs::read_to_string(&path) {
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let start = lines.len().saturating_sub(REPLAY);
        for line in &lines[start..] {
            let _ = app.emit("paw://line", line.to_string());
        }
        offset = text.len() as u64;
    }

    loop {
        thread::sleep(Duration::from_millis(POLL_MS));
        let size = match fs::metadata(&path) {
            Ok(m) => m.len(),
            Err(_) => continue, // not written yet; the bridge creates it
        };
        if size < offset {
            offset = 0; // truncated: start over
        }
        if size == offset {
            continue;
        }
        let Ok(mut f) = fs::File::open(&path) else { continue };
        if f.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let mut buf = String::new();
        if f.read_to_string(&mut buf).is_err() {
            continue;
        }
        offset = size;
        for line in buf.lines() {
            if !line.trim().is_empty() {
                let _ = app.emit("paw://line", line.to_string());
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // --- tray: show/hide, pin, quit ------------------------------
            let toggle = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
            let pin = MenuItem::with_id(app, "pin", "Always on top", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &pin, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("Paw")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let Some(w) = app.get_webview_window("main") else { return };
                    match event.id().as_ref() {
                        "toggle" => {
                            if w.is_visible().unwrap_or(true) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "pin" => {
                            let on = w.is_always_on_top().unwrap_or(true);
                            let _ = w.set_always_on_top(!on);
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            // --- the tail, on its own thread -------------------------------
            let handle = app.handle().clone();
            thread::spawn(move || tail(handle));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running paw");
}
