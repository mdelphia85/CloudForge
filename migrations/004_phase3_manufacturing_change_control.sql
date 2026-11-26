-- Phase 3: purchasing, allocation, engineering change control, shop-floor
-- execution, project planning, and field-service material history.
-- Additive only; Phase 1/2 records and immutable histories remain intact.

ALTER TABLE field_program_installs ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX field_program_installs_idempotency_idx
  ON field_program_installs(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (length(code) BETWEEN 2 AND 40),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  contact_name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  lead_time_days integer NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number text NOT NULL UNIQUE CHECK (length(po_number) BETWEEN 2 AND 60),
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','ordered','partially_received','received','cancelled')),
  order_date date,
  expected_delivery date,
  notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_orders_status_idx ON purchase_orders(status, expected_delivery);
CREATE INDEX purchase_orders_project_idx ON purchase_orders(project_id, status);

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 0),
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  ordered_qty numeric(15,3) NOT NULL CHECK (ordered_qty > 0),
  received_qty numeric(15,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  unit_price numeric(15,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  expected_delivery date,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_order_id, line_number)
);
CREATE INDEX purchase_order_lines_item_idx ON purchase_order_lines(item_id, project_id);

CREATE TABLE purchase_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_line_id uuid NOT NULL REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  quantity numeric(15,3) NOT NULL CHECK (quantity > 0),
  location text NOT NULL CHECK (length(location) BETWEEN 1 AND 160),
  bin text NOT NULL CHECK (length(bin) BETWEEN 1 AND 100),
  inventory_movement_id uuid NOT NULL UNIQUE REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  overage_authorized_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  received_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_receipts_line_idx ON purchase_receipts(purchase_order_line_id, received_at DESC);
CREATE TRIGGER purchase_receipts_append_only BEFORE UPDATE OR DELETE ON purchase_receipts
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  location text NOT NULL,
  bin text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  production_job_id uuid REFERENCES production_jobs(id) ON DELETE RESTRICT,
  field_service_job_id uuid REFERENCES field_service_jobs(id) ON DELETE RESTRICT,
  quantity numeric(15,3) NOT NULL CHECK (quantity > 0),
  consumed_qty numeric(15,3) NOT NULL DEFAULT 0 CHECK (consumed_qty >= 0 AND consumed_qty <= quantity),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','released','consumed')),
  idempotency_key text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(project_id, production_job_id, field_service_job_id) = 1),
  CHECK (status <> 'consumed' OR consumed_qty = quantity),
  FOREIGN KEY (item_id, location, bin)
    REFERENCES inventory_stock(item_id, location, bin) ON DELETE RESTRICT
);
CREATE INDEX inventory_reservations_stock_idx
  ON inventory_reservations(item_id, location, bin) WHERE status = 'reserved';
CREATE INDEX inventory_reservations_project_idx
  ON inventory_reservations(project_id, item_id) WHERE status = 'reserved';
CREATE INDEX inventory_reservations_job_idx
  ON inventory_reservations(production_job_id, item_id) WHERE status = 'reserved';
CREATE INDEX inventory_reservations_service_idx
  ON inventory_reservations(field_service_job_id, item_id) WHERE status = 'reserved';

CREATE TABLE engineering_bom_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision_code text NOT NULL CHECK (length(revision_code) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','review','approved','legacy','superseded')),
  change_notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision_code),
  CHECK ((approved_by IS NULL AND approved_at IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX engineering_bom_revisions_project_idx
  ON engineering_bom_revisions(project_id, status, created_at DESC);

CREATE TABLE engineering_bom_revision_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_revision_id uuid NOT NULL REFERENCES engineering_bom_revisions(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  required_qty numeric(15,3) NOT NULL CHECK (required_qty > 0),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bom_revision_id, item_id)
);
CREATE INDEX engineering_bom_revision_lines_item_idx
  ON engineering_bom_revision_lines(item_id, bom_revision_id);

WITH revisions AS (
  SELECT DISTINCT ON (project_id, revision)
    project_id, revision, added_by, created_at
  FROM engineering_bom_lines
  ORDER BY project_id, revision, created_at
), latest AS (
  SELECT DISTINCT ON (project_id) project_id, revision
  FROM engineering_bom_lines
  ORDER BY project_id, created_at DESC, revision DESC
)
INSERT INTO engineering_bom_revisions
  (project_id, revision_code, status, change_notes, created_by, approved_by, approved_at, created_at)
SELECT r.project_id, r.revision,
  CASE WHEN r.revision=latest.revision THEN 'legacy' ELSE 'superseded' END,
  'Imported from the Phase 2 engineering BOM; approval was not recorded in source data', r.added_by,
  NULL, NULL,
  r.created_at
FROM revisions r JOIN latest ON latest.project_id=r.project_id;

INSERT INTO engineering_bom_revision_lines
  (bom_revision_id, item_id, required_qty, notes, created_at)
SELECT r.id, b.item_id, b.required_qty, b.notes, b.created_at
FROM engineering_bom_lines b
JOIN engineering_bom_revisions r
  ON r.project_id = b.project_id AND r.revision_code = b.revision;
CREATE UNIQUE INDEX engineering_bom_one_approved_per_project_idx
  ON engineering_bom_revisions(project_id) WHERE status='approved';

CREATE TABLE engineering_change_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_number text NOT NULL UNIQUE CHECK (length(change_number) BETWEEN 2 AND 60),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 2 AND 2000),
  change_summary text NOT NULL DEFAULT '',
  implementation_notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','review','approved','rejected','implemented')),
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  implemented_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  implemented_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((approved_by IS NULL AND approved_at IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((implemented_by IS NULL AND implemented_at IS NULL) OR (implemented_by IS NOT NULL AND implemented_at IS NOT NULL))
);
CREATE INDEX engineering_change_orders_project_idx ON engineering_change_orders(project_id, status, created_at DESC);

CREATE TABLE engineering_change_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_order_id uuid NOT NULL REFERENCES engineering_change_orders(id) ON DELETE RESTRICT,
  document_id uuid REFERENCES engineering_documents(id) ON DELETE RESTRICT,
  bom_revision_id uuid REFERENCES engineering_bom_revisions(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  production_job_id uuid REFERENCES production_jobs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(document_id, bom_revision_id, asset_id, production_job_id) = 1)
);
CREATE INDEX engineering_change_links_order_idx ON engineering_change_links(change_order_id);

CREATE TABLE engineering_change_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_order_id uuid NOT NULL REFERENCES engineering_change_orders(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('submitted','approved','rejected','implemented')),
  notes text NOT NULL DEFAULT '',
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engineering_change_approvals_order_idx
  ON engineering_change_approvals(change_order_id, created_at DESC);
CREATE TRIGGER engineering_change_approvals_append_only BEFORE UPDATE OR DELETE ON engineering_change_approvals
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

ALTER TABLE project_tasks
  ADD CONSTRAINT project_tasks_id_project_unique UNIQUE (id, project_id);

CREATE TABLE project_task_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (task_id, project_id) REFERENCES project_tasks(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (depends_on_task_id, project_id) REFERENCES project_tasks(id, project_id) ON DELETE RESTRICT,
  UNIQUE (task_id, depends_on_task_id)
);
CREATE INDEX project_task_dependencies_project_idx ON project_task_dependencies(project_id, task_id);

CREATE TABLE project_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (length(code) BETWEEN 2 AND 40),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','blocked','completed')),
  due_date date,
  assignee_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code),
  UNIQUE (id, project_id)
);
CREATE INDEX project_milestones_project_idx ON project_milestones(project_id, due_date, status);

CREATE TABLE project_milestone_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  milestone_id uuid NOT NULL,
  depends_on_milestone_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (milestone_id <> depends_on_milestone_id),
  FOREIGN KEY (milestone_id, project_id) REFERENCES project_milestones(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (depends_on_milestone_id, project_id) REFERENCES project_milestones(id, project_id) ON DELETE RESTRICT,
  UNIQUE (milestone_id, depends_on_milestone_id)
);
CREATE INDEX project_milestone_dependencies_project_idx
  ON project_milestone_dependencies(project_id, milestone_id);

CREATE TABLE project_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  discipline text NOT NULL CHECK (length(discipline) BETWEEN 2 AND 80),
  allocation_percent numeric(5,2) NOT NULL DEFAULT 100
    CHECK (allocation_percent > 0 AND allocation_percent <= 100),
  starts_on date,
  ends_on date,
  notes text NOT NULL DEFAULT '',
  assigned_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  UNIQUE (project_id, user_id, discipline)
);
CREATE INDEX project_resources_user_idx ON project_resources(user_id, project_id);

CREATE TABLE project_cost_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  cost_type text NOT NULL CHECK (cost_type IN ('material','labor','other')),
  description text NOT NULL CHECK (length(description) BETWEEN 2 AND 240),
  source text NOT NULL CHECK (length(source) BETWEEN 2 AND 120),
  unit text NOT NULL CHECK (length(unit) BETWEEN 1 AND 32),
  quantity numeric(15,3) NOT NULL CHECK (quantity > 0),
  estimated_unit_cost numeric(15,4) CHECK (estimated_unit_cost >= 0),
  actual_unit_cost numeric(15,4) CHECK (actual_unit_cost >= 0),
  source_reference text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (estimated_unit_cost IS NOT NULL OR actual_unit_cost IS NOT NULL)
);
CREATE INDEX project_cost_entries_project_idx ON project_cost_entries(project_id, cost_type);

CREATE TABLE production_work_centers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (length(code) BETWEEN 2 AND 40),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  location text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE production_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (length(code) BETWEEN 2 AND 40),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at <> ends_at)
);

CREATE TABLE production_job_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_job_id uuid NOT NULL REFERENCES production_jobs(id) ON DELETE RESTRICT,
  work_center_id uuid NOT NULL REFERENCES production_work_centers(id) ON DELETE RESTRICT,
  shift_id uuid NOT NULL REFERENCES production_shifts(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE UNIQUE INDEX production_job_assignment_active_idx
  ON production_job_assignments(production_job_id) WHERE is_active;
CREATE UNIQUE INDEX production_job_assignment_operator_shift_active_idx
  ON production_job_assignments(operator_id, shift_id) WHERE is_active;
CREATE UNIQUE INDEX production_job_assignment_center_shift_active_idx
  ON production_job_assignments(work_center_id, shift_id) WHERE is_active;
CREATE INDEX production_job_assignment_center_idx
  ON production_job_assignments(work_center_id, shift_id, is_active);

CREATE TABLE production_downtime (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_job_id uuid NOT NULL REFERENCES production_jobs(id) ON DELETE RESTRICT,
  work_center_id uuid NOT NULL REFERENCES production_work_centers(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 2 AND 120),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  duration_seconds integer GENERATED ALWAYS AS (greatest(0, floor(extract(epoch FROM (ended_at - started_at)))::integer)) STORED,
  notes text NOT NULL DEFAULT '',
  operator_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at > started_at)
);
CREATE INDEX production_downtime_job_idx ON production_downtime(production_job_id, started_at DESC);
CREATE INDEX production_downtime_center_idx ON production_downtime(work_center_id, started_at DESC);

CREATE TABLE field_service_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_job_id uuid NOT NULL REFERENCES field_service_jobs(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('used','returned')),
  quantity numeric(15,3) NOT NULL CHECK (quantity > 0),
  location text NOT NULL,
  bin text NOT NULL,
  inventory_movement_id uuid NOT NULL UNIQUE REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  notes text NOT NULL DEFAULT '',
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, location, bin)
    REFERENCES inventory_stock(item_id, location, bin) ON DELETE RESTRICT
);
CREATE INDEX field_service_parts_job_idx ON field_service_parts(service_job_id, created_at DESC);
CREATE TRIGGER field_service_parts_append_only BEFORE UPDATE OR DELETE ON field_service_parts
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE field_service_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_job_id uuid NOT NULL REFERENCES field_service_jobs(id) ON DELETE RESTRICT,
  update_type text NOT NULL CHECK (update_type IN ('note','outcome','status')),
  status text,
  notes text NOT NULL CHECK (length(notes) BETWEEN 1 AND 2000),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((update_type = 'status' AND status IS NOT NULL) OR (update_type <> 'status' AND status IS NULL))
);
CREATE INDEX field_service_updates_job_idx ON field_service_updates(service_job_id, created_at DESC);
CREATE TRIGGER field_service_updates_append_only BEFORE UPDATE OR DELETE ON field_service_updates
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
