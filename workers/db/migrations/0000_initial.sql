-- Initial schema for agentic-inbox D1 database
-- Multi-tenant: all tables include mailbox_id for per-mailbox isolation

CREATE TABLE IF NOT EXISTS folders (
    mailbox_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_deletable INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (mailbox_id, id)
);

CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    subject TEXT,
    sender TEXT,
    recipient TEXT,
    cc TEXT,
    bcc TEXT,
    date TEXT,
    read INTEGER DEFAULT 0,
    starred INTEGER DEFAULT 0,
    body TEXT,
    in_reply_to TEXT,
    email_references TEXT,
    thread_id TEXT,
    message_id TEXT,
    raw_headers TEXT,
    FOREIGN KEY (mailbox_id, folder_id) REFERENCES folders(mailbox_id, id)
);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_id TEXT,
    disposition TEXT,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

-- Email indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_folder ON emails(mailbox_id, folder_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_thread ON emails(mailbox_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_date ON emails(mailbox_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to ON emails(mailbox_id, in_reply_to);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_subject ON emails(mailbox_id, subject);
CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_folders_mailbox ON folders(mailbox_id);
