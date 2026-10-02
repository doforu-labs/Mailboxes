-- Migration 0011: Admin account for the first-run setup wizard
--
-- Admin credentials used to come from the AUTH_USERNAME / AUTH_PASSWORD env
-- vars (with a hardcoded fallback). They now live here instead, and are
-- created exactly once by the first-run setup wizard (POST /api/v1/setup/admin).
--
-- NOTE: the `password` column holds a salted PBKDF2-SHA256 hash, in the format
--   pbkdf2-sha256$<iterations>$<salt-base64>$<hash-base64>
-- It is never returned to a client. Read the header of
-- workers/lib/password.ts before changing the format.
--
-- The application is "uninitialised" while this table is empty; every
-- visitor is sent to /setup until the first admin is created.

CREATE TABLE IF NOT EXISTS admins (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admins_username ON admins(username);
