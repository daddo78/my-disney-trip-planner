-- Friend codes replace friend links: a 6-character code (no 0/O/1/I/L) shown in the account pop-up.
-- Old 24-character links are swapped for a code the next time their owner loads /api/me.
ALTER TABLE users RENAME COLUMN link TO code;
-- Wrong friend codes per account per hour, so codes can't be guessed.
CREATE TABLE IF NOT EXISTS friend_tries (
  user_id TEXT PRIMARY KEY,
  since INTEGER NOT NULL,
  count INTEGER NOT NULL
);
-- How you know each friend ("Sister", "College roommate"), set by you on the Friends tab; each side keeps its own.
ALTER TABLE friends ADD COLUMN rel TEXT NOT NULL DEFAULT '';
