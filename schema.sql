-- The founder list. One row per person, nothing we do not need: an address
-- to reach them on, when they signed up, which page they came from, and the
-- confirm-link token. A row only counts toward the 250 once confirmed_at is
-- set, which proves a person can read mail at that address.
CREATE TABLE IF NOT EXISTS preorders (
  email        TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'pro',
  token        TEXT NOT NULL UNIQUE,
  confirmed_at TEXT
);
