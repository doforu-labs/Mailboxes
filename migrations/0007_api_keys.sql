-- API keys table for programmatic email sending access
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'send',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_mailbox ON api_keys(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
