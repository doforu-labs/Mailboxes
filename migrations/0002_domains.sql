-- Domains table for multi-domain support
-- Tracks verified email domains with Resend and Cloudflare configuration

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  resend_domain_id TEXT,
  cf_zone_id TEXT,
  cf_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
