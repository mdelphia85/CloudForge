-- Bind every session to an authenticated organization membership.
-- This is safe while 012's single-organization guard remains in force.
-- No additional organizations may be admitted until every data path is isolated.
ALTER TABLE sessions
  ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT;

UPDATE sessions s
SET organization_id = m.organization_id
FROM organization_memberships m
WHERE m.user_id = s.user_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sessions WHERE organization_id IS NULL) THEN
    RAISE EXCEPTION 'Existing sessions could not be assigned to their organization';
  END IF;
END;
$$;

ALTER TABLE sessions ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX sessions_organization_user_idx ON sessions (organization_id, user_id);

-- organization_memberships already has a composite primary key (organization_id, user_id).
