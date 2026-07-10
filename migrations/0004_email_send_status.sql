-- Add send_status column to track outbound email delivery state
-- Values: NULL (not sent), "sending", "sent", "failed"
ALTER TABLE emails ADD COLUMN send_status TEXT DEFAULT NULL;
