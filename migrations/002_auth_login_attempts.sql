-- Temporary per-identifier counters for public login brute-force protection.
-- Store a SHA-256 identifier, never the raw email address or attempted password.
CREATE TABLE auth_login_attempts (
  identifier_hash char(64) PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_login_attempts_updated_at_idx ON auth_login_attempts (updated_at);
