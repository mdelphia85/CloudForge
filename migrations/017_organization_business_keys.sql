-- Change global business-identifiers to per-organization uniqueness.
-- This is additive for the existing installation because migration 012 has
-- already attached all historical rows to its original organization.
-- Do not enable additional organizations until the complete RLS/API audit passes.
ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_org_sku_unique UNIQUE (organization_id,sku);
ALTER TABLE projects
  ADD CONSTRAINT projects_org_code_unique UNIQUE (organization_id,code);
ALTER TABLE engineering_assets
  ADD CONSTRAINT engineering_assets_org_tag_unique UNIQUE (organization_id,asset_tag);
ALTER TABLE production_jobs
  ADD CONSTRAINT production_jobs_org_code_unique UNIQUE (organization_id,job_code);
ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_org_code_unique UNIQUE (organization_id,code);
ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_org_number_unique UNIQUE (organization_id,po_number);
ALTER TABLE engineering_change_orders
  ADD CONSTRAINT engineering_change_orders_org_number_unique UNIQUE (organization_id,change_number);

-- No public query must use a code alone without first restricting the tenant.
-- Tenant-aware query updates are independent of this DDL migration.
ALTER TABLE inventory_items DROP CONSTRAINT inventory_items_sku_key;
ALTER TABLE projects DROP CONSTRAINT projects_code_key;
ALTER TABLE engineering_assets DROP CONSTRAINT engineering_assets_asset_tag_key;
ALTER TABLE production_jobs DROP CONSTRAINT production_jobs_job_code_key;
ALTER TABLE suppliers DROP CONSTRAINT suppliers_code_key;
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_po_number_key;
ALTER TABLE engineering_change_orders DROP CONSTRAINT engineering_change_orders_change_number_key;
