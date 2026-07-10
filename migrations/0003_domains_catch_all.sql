-- Add catch-all mailbox support to domains table
-- When set, emails for non-existent addresses on this domain are routed here

ALTER TABLE domains ADD COLUMN catch_all_mailbox TEXT;
