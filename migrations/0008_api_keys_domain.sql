-- Migration 0008: Change api_keys from mailbox-level to domain-level
-- Drops old table and recreates with domain_id instead of mailbox_id

DROP TABLE IF EXISTS api_keys;

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'send',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_domain ON api_keys(domain_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
