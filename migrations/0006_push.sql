-- Web Push subscriptions: one per browser/device that turned notifications on.
CREATE TABLE push_subs (
  endpoint   TEXT PRIMARY KEY,   -- push service URL; unique per browser install
  username   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT,               -- e.g. "Android · Chrome", to tell devices apart in Settings
  created_at INTEGER NOT NULL,
  last_ok    INTEGER,            -- last time the push service accepted a message
  fails      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subs_user ON push_subs (username);
