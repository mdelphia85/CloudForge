-- Customer identity security: TOTP MFA, encrypted setup material, and one-time recovery codes.
-- All existing accounts remain un-enrolled until users complete setup.
ALTER TABLE users
  ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN mfa_secret_encrypted text,
  ADD COLUMN mfa_pending_secret_encrypted text,
  ADD COLUMN mfa_pending_expires_at timestamptz,
  ADD COLUMN mfa_last_counter bigint NOT NULL DEFAULT -1,
  ADD CONSTRAINT users_mfa_secret_consistency_check
    CHECK ((NOT mfa_enabled) OR mfa_secret_encrypted IS NOT NULL),
  ADD CONSTRAINT users_mfa_pending_consistency_check
    CHECK ((mfa_pending_secret_encrypted IS NULL) = (mfa_pending_expires_at IS NULL));

ALTER TABLE sessions
  ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;

CREATE TABLE user_mfa_recovery_codes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  PRIMARY KEY (user_id,code_hash)
);
CREATE INDEX user_mfa_recovery_unused_idx
  ON user_mfa_recovery_codes(user_id) WHERE consumed_at IS NULL;

-- Explicitly authenticate with TOTP or a recovery code after initial enrollment.
-- No server-inferred MFA verification for existing browser sessions.
