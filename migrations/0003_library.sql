-- Per-person book records that can't be derived from reading data: rating, note, manual status.
CREATE TABLE user_books (
  username    TEXT NOT NULL,
  document    TEXT NOT NULL,
  status      TEXT,              -- NULL = automatic; 'finished' | 'abandoned' | 'reading' override it
  finished_at INTEGER,           -- set when marked finished by hand
  rating      INTEGER,           -- 1–5
  review      TEXT,
  review_at   INTEGER,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (username, document)
);

-- Books someone wants to read (not linked to a file yet).
CREATE TABLE wishlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  title      TEXT NOT NULL,
  authors    TEXT,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX wishlist_user ON wishlist (username, created_at);
