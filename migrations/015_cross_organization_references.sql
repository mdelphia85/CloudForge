-- Defense in depth: a customer-owned row may reference only a record in
-- the SAME organization, even if an application route forgets to check it.
-- Migration 012 remains single-organization until all API paths are scoped.
-- This migration does not remove that critical guard.
DO $$
DECLARE
  parent RECORD;
  relation RECORD;
  parent_index TEXT;
  tenant_constraint TEXT;
BEGIN
  FOR parent IN
    SELECT c.oid, c.oid::regclass AS qualified_name
    FROM pg_class c
    WHERE c.relkind IN ('r','p')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
                  AND a.attname='organization_id' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
                  AND a.attname='id' AND NOT a.attisdropped)
  LOOP
    parent_index := format('tenant_uq_%s', parent.oid);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %s (organization_id,id)',
      parent_index,parent.qualified_name);
  END LOOP;

  FOR relation IN
    SELECT f.oid, f.conrelid::regclass AS child_table,
           f.confrelid::regclass AS parent_table,
           ca.attname AS child_column
    FROM pg_constraint f
    JOIN pg_attribute ca
      ON ca.attrelid=f.conrelid AND ca.attnum=f.conkey[1]
    JOIN pg_attribute pa
      ON pa.attrelid=f.confrelid AND pa.attnum=f.confkey[1]
    WHERE f.contype='f'
      AND array_length(f.conkey,1)=1
      AND array_length(f.confkey,1)=1
      AND pa.attname='id'
      AND ca.attname <> 'organization_id'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=f.conrelid
                  AND a.attname='organization_id' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=f.confrelid
                  AND a.attname='organization_id' AND NOT a.attisdropped)
  LOOP
    tenant_constraint := format('tenant_fk_%s', relation.oid);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (organization_id,%I) ' ||
      'REFERENCES %s(organization_id,id) NOT VALID',
      relation.child_table,tenant_constraint,relation.child_column,relation.parent_table);
    -- Historical rows are associated with one original organization by 012.
    -- Validate now so a pre-existing discrepancy cannot remain undetected.
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I',
      relation.child_table,tenant_constraint);
  END LOOP;
END;
$$;
