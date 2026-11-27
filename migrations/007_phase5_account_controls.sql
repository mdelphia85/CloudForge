-- Invalidate in-flight sign-ins when an administrator disables an account
-- or revokes its sessions.
ALTER TABLE users ADD COLUMN session_epoch integer NOT NULL DEFAULT 0 CHECK (session_epoch >= 0);
