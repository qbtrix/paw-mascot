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

-- Licences sold. Added 2026-09-19 with the licence server. One row per paid
-- payment, which is also the idempotency key: Dodo retries a webhook until it
-- gets a 200, and the same payment arriving twice must not mint twice. A
-- repeat buyer pays twice and gets two rows, which is correct -- two seats.
--
-- seat is the founder number printed in the key. It is taken as COUNT(*)+1
-- inside the INSERT, and UNIQUE makes a race a failed insert (Dodo retries)
-- rather than two people holding seat 7. The key is stored so a resend mails
-- the same key rather than minting a second one for the same purchase.
CREATE TABLE IF NOT EXISTS licenses (
  payment_id TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  seat       INTEGER NOT NULL UNIQUE,
  key_id     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS licenses_email ON licenses (email);
