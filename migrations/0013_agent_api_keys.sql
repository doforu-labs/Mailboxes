-- Migration 0013: Global agent API keys for external LLM access
--
-- These keys let an external LLM (or any other programmatic client) call the
-- internal agent tools over the public API. Unlike the removed `mb_` keys
-- (migrations 0007/0008, dropped in 0012) these are GLOBAL: they are not scoped
-- to a mailbox or a domain, and authorisation is decided by the `scopes` /
-- `allowed_mailboxes` columns instead.
--
-- `key_hash` holds the SHA-256 hash of the key. The plaintext key is shown to
-- the operator exactly once, at creation time, and is never stored — so a
-- database dump never yields a usable credential.
--
-- `allowed_mailboxes` is a JSON array of mailbox ids, or NULL for "all
-- mailboxes". It is only meaningful when `scopes` opts into mailbox-scoped
-- access; readers must treat NULL as unrestricted.
--
-- `revoked_at` is NULL while the key is live; setting it disables the key
-- without losing the audit trail that references it.

CREATE TABLE IF NOT EXISTS agent_api_keys (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  key_hash          TEXT NOT NULL,
  prefix            TEXT NOT NULL,
  scopes            TEXT NOT NULL DEFAULT 'all',
  allowed_mailboxes TEXT,
  created_at        TEXT NOT NULL,
  last_used_at      TEXT,
  expires_at        TEXT,
  revoked_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_api_keys_hash ON agent_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_agent_api_keys_prefix ON agent_api_keys(prefix);

-- Append-only log of what each key did. Rows are never updated or deleted, so
-- revoking a key keeps its history intact.
CREATE TABLE IF NOT EXISTS agent_api_key_audit (
  id         TEXT PRIMARY KEY,
  key_id     TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_api_key_audit_key ON agent_api_key_audit(key_id);
