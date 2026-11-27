-- Unauthenticated attempts cannot truthfully be attributed to an account.
ALTER TABLE audit_events
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ALTER COLUMN entity_id DROP NOT NULL,
  ADD CONSTRAINT audit_events_actor_target_check CHECK (
    (actor_user_id IS NOT NULL AND entity_id IS NOT NULL)
    OR
    (actor_user_id IS NULL AND entity_id IS NULL
      AND action = 'auth.login_failed' AND entity_type = 'authentication')
  );
