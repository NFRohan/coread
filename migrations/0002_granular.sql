-- Link every push to its reading session, for per-session timelines and per-section time.
ALTER TABLE events ADD COLUMN session_id INTEGER;

UPDATE events SET session_id = (
  SELECT s.id FROM sessions s
  WHERE s.username = events.username AND s.document = events.document
    AND events.ts BETWEEN s.start_ts AND s.end_ts
  ORDER BY s.start_ts DESC LIMIT 1
);

CREATE INDEX events_session ON events (session_id, ts);
CREATE INDEX events_doc ON events (document, username, ts);
