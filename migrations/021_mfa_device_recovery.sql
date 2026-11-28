-- Preserve the distinction between a TOTP-authenticated session and a
-- session established using a consumed emergency recovery code.
-- Authenticated recovery sessions may replace an inaccessible authenticator;
-- ordinary sessions cannot bypass the active MFA requirement.
ALTER TABLE sessions
  ADD COLUMN mfa_recovery_authenticated boolean NOT NULL DEFAULT false;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_recovery_requires_mfa_check
    CHECK (NOT mfa_recovery_authenticated OR mfa_verified);
