-- Distinct electrical and mechanical drawing libraries, preserving existing drawings and code.
-- Reserved 013 to avoid colliding with the draft PR #12 organization migration 012.
ALTER TABLE engineering_documents
  DROP CONSTRAINT engineering_documents_kind_check;
ALTER TABLE engineering_documents
  ADD CONSTRAINT engineering_documents_kind_check
  CHECK (kind IN ('drawing','spec','bom','manual','sop','plc','hmi','electrical_schematic','mechanical_schematic','other'));

-- Interim PostgreSQL bytea storage; native project archives can be larger than the original 15 MB cap.
-- Longer-term object storage should avoid buffering larger engineering projects in application memory.
ALTER TABLE engineering_revisions
  DROP CONSTRAINT engineering_revisions_byte_size_check;
ALTER TABLE engineering_revisions
  ADD CONSTRAINT engineering_revisions_byte_size_check
  CHECK (byte_size > 0 AND byte_size <= 52428800);
