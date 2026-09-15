-- The pre-order list. One row per person, nothing we do not need: an address
-- to reach them on, when they signed up, and which page they came from.
CREATE TABLE IF NOT EXISTS preorders (
  email      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'pro'
);
