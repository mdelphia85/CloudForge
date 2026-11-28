-- Multi-organization invitation and explicit membership foundation.
-- Stop the legacy trigger from silently adding every new user to the existing
-- installation, which would be a cross-customer access vulnerability.
DROP TRIGGER users_existing_organization_membership ON users;
DROP FUNCTION maintain_existing_organization_membership();

CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email=lower(email)),
  role text NOT NULL CHECK (role IN ('admin','operator','viewer')),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CHECK (expires_at > created_at)
);
CREATE INDEX organization_invitations_lookup_idx
  ON organization_invitations(organization_id,email,created_at DESC);
CREATE INDEX organization_invitations_expiration_idx
  ON organization_invitations(expires_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX organization_invitations_one_pending_idx
  ON organization_invitations(organization_id,email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- This table is part of the platform provisioning control plane. It is not a
-- generic data resource and must be accessed only by explicit, authorized
-- invitation issuance/acceptance endpoints; do not expose its token hashes.
-- The operational RLS default remains in place for customer data elsewhere.
