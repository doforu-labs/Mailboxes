-- Migration 0015: per-IP rate limit for the public demo's guest sign-in
--
-- `POST /api/v1/auth/demo-login` has nothing to guess (there is no demo
-- password, see workers/demo/login.ts), so the only thing worth limiting is
-- how FAST a client can mint sessions. Each call writes a `sessions` row, and
-- before this table existed a script could write an unbounded number of them.
--
-- One row per (bucket, window start). The window is a fixed 10 minutes, so
-- `window_start` is `floor(now / 600000) * 600000` (epoch milliseconds) and a
-- row is created by the first attempt of a window and incremented by the rest:
--
--   INSERT INTO demo_login_rate_limit (bucket, window_start, hits, expires_at)
--   VALUES (?, ?, 1, ?)
--   ON CONFLICT (bucket, window_start) DO UPDATE SET hits = hits + 1
--   RETURNING hits
--
-- That is a single atomic statement, which is the point: a read-then-write
-- ("SELECT hits; if (hits < N) UPDATE") loses to concurrency, and a limiter
-- that can be raced is not a limiter. `RETURNING hits` also means the caller
-- learns the post-increment count without a second round trip.
--
-- `bucket` is `ip:<client address>`, or `ua:<hash>` when the request carries no
-- client IP at all (local `vite preview`, a non-Cloudflare edge). The fallback
-- is deliberately coarse-but-not-global — see the comment in
-- workers/demo/login.ts for why the two obvious alternatives (one shared
-- bucket for everyone, or no limiting at all) are both wrong.
--
-- `expires_at` is `window_start + 2 * window` (epoch ms): one window of grace,
-- so a window that is still counting can never be swept by the opportunistic
-- cleanup that runs when a fresh window starts. Cleanup is a plain
-- `DELETE ... WHERE expires_at < now` — no Cron, no KV binding, no extra
-- dependency.
--
-- Only ever applied to the demo database (scripts/deploy-demo.mjs). The
-- production database never grew this table, and never needs it: the handler
-- returns 404 before it reads the table unless DEMO_MODE=1. The 6-hour demo
-- reset (workers/demo/reset.ts) deliberately does NOT wipe this table — a reset
-- would otherwise hand every client a fresh allowance.

CREATE TABLE IF NOT EXISTS demo_login_rate_limit (
  bucket       TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
) WITHOUT ROWID;

-- Sweep path: the cleanup DELETE is the only query that does not know the
-- window up front, so it needs its own index.
CREATE INDEX IF NOT EXISTS demo_login_rate_limit_expires_at
  ON demo_login_rate_limit (expires_at);
