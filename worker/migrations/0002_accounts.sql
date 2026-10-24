-- Accounts: sign in with an emailed 6-digit code, friends by a personal link, trips shared with the people on them.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL UNIQUE,          -- friend link token: /#friend=<link>
  created TEXT NOT NULL
);
-- One pending code per email: SHA-256 of "email:code", good for 10 minutes and 5 tries.
CREATE TABLE IF NOT EXISTS codes (
  email TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL
);
-- Session cookie tokens, stored as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires INTEGER NOT NULL
);
-- Friendships, one row each way.
CREATE TABLE IF NOT EXISTS friends (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  PRIMARY KEY (a, b)
);
-- Who can see and edit each trip: its creator (owner = 1) and the accounts linked on its Who's going list.
CREATE TABLE IF NOT EXISTS members (
  trip TEXT NOT NULL,
  user_id TEXT NOT NULL,
  owner INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members (user_id);
