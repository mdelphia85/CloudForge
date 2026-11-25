-- Phase 2: one organization per deployment, integrated project-to-service records.
-- Additive: never rewrites or removes Phase 1 inventory and audit history.

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (length(code) BETWEEN 2 AND 40),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  customer text NOT NULL CHECK (length(customer) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','on_hold','completed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_date date,
  owner_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_status_idx ON projects (status, due_date);

CREATE TABLE project_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 240),
  discipline text NOT NULL CHECK (discipline IN ('engineering','project','production','field_service')),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','done')),
  assignee_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  due_date date,
  notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_tasks_project_idx ON project_tasks(project_id,status);

CREATE TABLE engineering_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  asset_tag text NOT NULL UNIQUE CHECK (length(asset_tag) BETWEEN 2 AND 80),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  customer_site text NOT NULL CHECK (length(customer_site) BETWEEN 2 AND 200),
  area text NOT NULL DEFAULT '',
  plc_make text NOT NULL DEFAULT '',
  plc_model text NOT NULL DEFAULT '',
  hmi_make text NOT NULL DEFAULT '',
  hmi_model text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engineering_assets_project_idx ON engineering_assets(project_id);

CREATE TABLE engineering_bom_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  required_qty numeric(15,3) NOT NULL CHECK (required_qty > 0),
  revision text NOT NULL DEFAULT 'A',
  notes text NOT NULL DEFAULT '',
  added_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,item_id,revision)
);
CREATE INDEX engineering_bom_project_idx ON engineering_bom_lines(project_id);

CREATE TABLE engineering_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  kind text NOT NULL CHECK (kind IN ('drawing','spec','bom','manual','sop','plc','hmi','other')),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (project_id IS NOT NULL OR asset_id IS NOT NULL)
);
CREATE INDEX engineering_documents_asset_idx ON engineering_documents(asset_id);
CREATE INDEX engineering_documents_project_idx ON engineering_documents(project_id);

CREATE TABLE engineering_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES engineering_documents(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  file_name text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 15728640),
  sha256 char(64) NOT NULL,
  file_data bytea NOT NULL,
  change_notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,revision),
  CHECK ((approved_by IS NULL AND approved_at IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX engineering_revisions_document_idx ON engineering_revisions(document_id,revision DESC);

CREATE TABLE production_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  job_code text NOT NULL UNIQUE CHECK (length(job_code) BETWEEN 2 AND 60),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  planned_qty numeric(15,3) NOT NULL CHECK (planned_qty > 0),
  completed_qty numeric(15,3) NOT NULL DEFAULT 0 CHECK (completed_qty >= 0),
  scrap_qty numeric(15,3) NOT NULL DEFAULT 0 CHECK (scrap_qty >= 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','in_progress','on_hold','completed')),
  assigned_to uuid REFERENCES users(id) ON DELETE RESTRICT,
  due_date date,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completed_qty + scrap_qty <= planned_qty)
);
CREATE INDEX production_jobs_project_idx ON production_jobs(project_id,status);

CREATE TABLE production_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES production_jobs(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('start','hold','resume','progress','scrap','complete','note')),
  quantity numeric(15,3) NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  notes text NOT NULL DEFAULT '',
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_events_job_idx ON production_events(job_id,created_at DESC);
CREATE TRIGGER production_events_append_only BEFORE UPDATE OR DELETE ON production_events
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE purchase_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity numeric(15,3) NOT NULL CHECK(quantity > 0),
  supplier text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','ordered','received','cancelled')),
  reference text NOT NULL DEFAULT '',
  needed_by date,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_requests_project_idx ON purchase_requests(project_id,status);

CREATE TABLE field_service_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES engineering_assets(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','scheduled','in_progress','completed')),
  assigned_to uuid REFERENCES users(id) ON DELETE RESTRICT,
  scheduled_date date,
  notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_service_asset_idx ON field_service_jobs(asset_id,status);

CREATE TABLE field_program_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_job_id uuid NOT NULL REFERENCES field_service_jobs(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES engineering_revisions(id) ON DELETE RESTRICT,
  result text NOT NULL CHECK(result IN ('installed','failed','rolled_back')),
  notes text NOT NULL DEFAULT '',
  performed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  performed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_program_installs_job_idx ON field_program_installs(service_job_id,performed_at DESC);
CREATE TRIGGER field_program_installs_append_only BEFORE UPDATE OR DELETE ON field_program_installs
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
