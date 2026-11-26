-- Correct Phase 3 review findings without changing previously recorded facts.

ALTER TABLE engineering_bom_revisions
  DROP CONSTRAINT engineering_bom_revisions_status_check;
ALTER TABLE engineering_bom_revisions
  ADD CONSTRAINT engineering_bom_revisions_status_check
  CHECK (status IN ('draft','review','approved','legacy','superseded'));

WITH imported AS (
  SELECT id, project_id,
    row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC, revision_code DESC) AS revision_rank
  FROM engineering_bom_revisions
  WHERE change_notes LIKE 'Imported from the Phase 2 engineering BOM%'
)
UPDATE engineering_bom_revisions r
SET status = CASE WHEN i.revision_rank = 1 THEN 'legacy' ELSE 'superseded' END,
    approved_by = NULL,
    approved_at = NULL,
    updated_at = now()
FROM imported i
WHERE i.id = r.id
  AND NOT EXISTS (
    SELECT 1
    FROM audit_events a
    WHERE a.entity_type = 'engineering_bom_revision'
      AND a.entity_id = r.id
      AND a.action = 'engineering.bom_revision.approved'
  );

CREATE TABLE engineering_change_implementation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_order_link_id uuid NOT NULL UNIQUE
    REFERENCES engineering_change_links(id) ON DELETE RESTRICT,
  document_revision_id uuid REFERENCES engineering_revisions(id) ON DELETE RESTRICT,
  bom_revision_id uuid REFERENCES engineering_bom_revisions(id) ON DELETE RESTRICT,
  notes text NOT NULL CHECK (length(notes) BETWEEN 1 AND 2000),
  verified_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verified_at timestamptz NOT NULL DEFAULT now(),
  CHECK (document_revision_id IS NULL OR bom_revision_id IS NULL)
);
CREATE INDEX engineering_change_implementation_evidence_revision_idx
  ON engineering_change_implementation_evidence(document_revision_id)
  WHERE document_revision_id IS NOT NULL;
CREATE INDEX engineering_change_implementation_evidence_bom_idx
  ON engineering_change_implementation_evidence(bom_revision_id)
  WHERE bom_revision_id IS NOT NULL;
CREATE TRIGGER engineering_change_implementation_evidence_append_only
  BEFORE UPDATE OR DELETE ON engineering_change_implementation_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
