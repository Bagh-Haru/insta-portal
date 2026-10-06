ALTER TABLE publications ADD COLUMN retry_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publications ADD COLUMN next_attempt_at INTEGER;
