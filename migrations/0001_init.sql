-- Accounts. key_hash = sha256(salt:userkey), where userkey is the md5(password) sent by KOReader-sync clients.
CREATE TABLE users (
  username   TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL,
  salt       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Latest position per user and book: what the sync protocol reads back.
CREATE TABLE progress (
  username   TEXT NOT NULL,
  document   TEXT NOT NULL,
  progress   TEXT,
  percentage REAL,
  device     TEXT,
  device_id  TEXT,
  timestamp  INTEGER NOT NULL,
  PRIMARY KEY (username, document)
);

-- Book names, when the client sends document metadata.
CREATE TABLE books (
  document   TEXT PRIMARY KEY,
  title      TEXT,
  authors    TEXT,
  filename   TEXT,
  updated_at INTEGER NOT NULL
);

-- Every progress push (history for stats).
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  document   TEXT NOT NULL,
  percentage REAL,
  section    INTEGER,
  device     TEXT,
  ts         INTEGER NOT NULL
);
CREATE INDEX events_user_ts ON events (username, ts);

-- Pushes grouped into reading sessions (a gap of more than 10 minutes, or a different book, starts a new one).
CREATE TABLE sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  document      TEXT NOT NULL,
  device        TEXT,
  start_ts      INTEGER NOT NULL,
  end_ts        INTEGER NOT NULL,
  start_pct     REAL,
  end_pct       REAL,
  start_section INTEGER,
  end_section   INTEGER,
  pushes        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX sessions_user_end ON sessions (username, end_ts);
CREATE INDEX sessions_start ON sessions (start_ts);

-- Things worth showing in the activity feed (also what was sent as notifications).
CREATE TABLE activity (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  actor    TEXT,
  document TEXT,
  text     TEXT NOT NULL
);
CREATE INDEX activity_ts ON activity (ts);

-- Small key/value state for notification de-duplication and cooldowns.
CREATE TABLE flags (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);
