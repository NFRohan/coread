-- Handle several devices per person explicitly:
--  * events.moved = 0 marks pushes where the position didn't change (app focus/blur, re-syncs on an idle device)
--  * sessions are tracked per device, so a phone and a laptop can each have their own session in parallel
ALTER TABLE events ADD COLUMN device_id TEXT;
ALTER TABLE events ADD COLUMN moved INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN device_id TEXT;

UPDATE events SET device_id = COALESCE(device, 'unknown') WHERE device_id IS NULL;
UPDATE sessions SET device_id = COALESCE(device, 'unknown') WHERE device_id IS NULL;

CREATE INDEX events_user_moved ON events (username, moved, ts);
CREATE INDEX events_user_device ON events (username, device_id, ts);
CREATE INDEX sessions_user_device ON sessions (username, device_id, end_ts);
