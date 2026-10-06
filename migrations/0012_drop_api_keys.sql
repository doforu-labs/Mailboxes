-- Migration 0012: Remove the programmatic-sending API key feature
--
-- The `mb_`-prefixed, domain-scoped API keys used to authenticate
-- POST /api/v1/send have been removed from the application entirely, so the
-- backing table is no longer read or written.
--
-- Migrations 0007 (mailbox-level) and 0008 (domain-level) created and then
-- reshaped this table; both are kept as-is because they are already applied
-- to production databases. This migration drops the table and its indexes.
--
-- NOTE: this only removes Mailboxes' own API keys. It does NOT touch the
-- per-domain `resend_api_key` column on `domains`, which is the Resend
-- provider credential used for actually sending mail.

DROP TABLE IF EXISTS api_keys;
