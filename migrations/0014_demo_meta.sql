-- Migration 0014: demo-only bookkeeping for the public read-only demo instance
--
-- This table has exactly one job: give the 6-hour reset a single row that can
-- be claimed ATOMICALLY, so two concurrent resets (a Cron tick and a visitor's
-- lazy demo-login fallback) can never both wipe and re-seed the database.
--
-- The claim is a compare-and-swap on `value`:
--
--   UPDATE demo_meta SET value = <now> WHERE key = 'last_reset_at' AND value = <old>
--
-- Whoever's UPDATE reports `changes = 0` lost the race and must NOT reset; it
-- just proceeds with what the winner is writing. One row, one statement, no
-- read-modify-write window.
--
-- Only ever applied to the demo database (see wrangler.demo.jsonc). Nothing in
-- the production code path reads or writes it: the reset module is reached only
-- when DEMO_MODE=1, so production keeps behaving exactly as before even if this
-- table does not exist there.

CREATE TABLE IF NOT EXISTS demo_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- last_reset_at: ISO-8601 UTC timestamp of the reset that last completed.
INSERT OR IGNORE INTO demo_meta (key, value) VALUES ('last_reset_at', '1970-01-01T00:00:00.000Z');
