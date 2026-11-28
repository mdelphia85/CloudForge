-- Optional replenishment suggestions: never send external orders automatically.
-- Existing inventory retains manual-only behavior by default.
ALTER TABLE inventory_items
  ADD COLUMN auto_reorder_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_reorder_quantity numeric(15,3) NOT NULL DEFAULT 0,
  ADD CONSTRAINT inventory_items_auto_reorder_quantity_check
    CHECK (auto_reorder_quantity >= 0
      AND (NOT auto_reorder_enabled OR auto_reorder_quantity > 0));

ALTER TABLE purchase_requests
  ADD COLUMN request_origin text NOT NULL DEFAULT 'manual',
  ADD CONSTRAINT purchase_requests_origin_check
    CHECK (request_origin IN ('manual','auto_reorder'));

-- Exactly one unresolved auto-reorder request per item, per company.
-- This is robust even if multiple workers evaluate the same item concurrently.
CREATE UNIQUE INDEX purchase_requests_one_open_auto_reorder
  ON purchase_requests (organization_id,item_id)
  WHERE request_origin='auto_reorder' AND status IN ('requested','ordered');

CREATE INDEX inventory_auto_reorder_enabled_idx
  ON inventory_items (organization_id,id)
  WHERE auto_reorder_enabled AND is_active;

CREATE INDEX purchase_requests_auto_reorder_review_idx
  ON purchase_requests (organization_id,created_at DESC)
  WHERE request_origin='auto_reorder';
