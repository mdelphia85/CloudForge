# Cloud Forge

Cloud Forge is a deployment-neutral operations platform beginning with the Phase 1 inventory foundation. It is designed to run in cloud, customer-managed on-prem, air-gapped, and local environments from the same application release.

Inventory uses PostgreSQL-backed records, local password accounts, server-side role checks, and transactional movement/audit history. Phase 2 connects project management, engineering, production, purchasing, and field service to the same database and inventory system.

The operations workspace supports project tasks, equipment and BOM records, purchasing requests, and production jobs. Engineering users can upload PLC/HMI program revisions and administrators can approve releases; authorized administrators and operators can download approved releases, while field-service records capture installations. Production material issues update stock, movement history, production events, and audit history in one transaction.

Phase 3 adds supplier-backed purchase orders and receiving, project/job material reservations and shortage visibility, revisioned BOMs that keep imported Phase 2 demand provisional until explicitly approved, and evidence-backed engineering change implementation. Production work-center/shift/operator assignments, chronology-validated downtime, overlap-aware project resource allocations, milestones/dependencies/costs, and field-service parts and work logs share PostgreSQL records and update inventory transactionally. Field-service histories and installations are restricted to assigned technicians and authorized staff; approved PLC/HMI downloads remain limited to programs associated with the equipment or project. Open `/operations/phase3` for the Phase 3 workspace; the existing inventory and Phase 2 workspaces remain available.

Phase 4 adds an equipment registry and hierarchy, preventive-maintenance plans and work orders, checklists, technician assignments, transactional parts issue/return, maintenance costs, equipment downtime, simulated read-only telemetry, and reliability reporting. Open `/operations/equipment` to register equipment, review maintenance and status, and generate simulated running, stopped, fault, stale, offline, delayed, or invalid samples. The Phase 4 baseline uses simulated telemetry; Phase 5 adds the optional gateway described below.

Phase 5 adds equipment alarm rules for simulated and gateway sources. Administrators and operators can configure and edit thresholds or state matches, severity and consecutive-sample debounce, acknowledge alarms, and pause or edit rules after active alarms clear. Edits reset pending debounce and audit the previous and new configurations. Only new, fresh, good-quality, ordered readings evaluate rules; duplicate, stale and bad readings do not. Alarm transitions and acknowledgements have immutable history. These application alarms are not a safety system, and acknowledging one never resets a PLC.

The customer-managed Phase 5 gateway uses a protocol-neutral acquisition interface and shared delivery pipeline; its first provider polls explicitly mapped OPC UA nodes over an encrypted channel with certificate trust and a pinned server fingerprint. It is disabled until explicitly configured. Signed gateway batches are buffered locally and delivered to allowlisted equipment tags; real-source and simulator histories remain separate. Gateway setup, security boundaries, failure handling and recovery are documented in [docs/gateway.md](docs/gateway.md). No physical equipment has been tested or connected.

These are operational workflows, not a production-launch claim: the gateway queue buffers telemetry only; there is no offline business-mutation synchronization, live PLC/HMI transfer, automatic production scheduling, or multi-organization tenant isolation.

This first slice is for one organization per deployment. Do not place multiple customer organizations in one shared database/deployment; tenant isolation and organization switching are not implemented yet.

See [docs/architecture.md](docs/architecture.md) for the deployment model, backend sequence, and compliance boundaries.

See [docs/frontend-product-blueprint.md](docs/frontend-product-blueprint.md) for the frontend information architecture, role workspaces, interaction patterns, AI surfaces, and build order.

## Development

Install dependencies and run the development server:

```bash
npm install
```

Open http://localhost:3000 in your browser.

Copy `.env.example` to `.env.local`, configure `DATABASE_URL`, and start PostgreSQL 13 or later. No domain is needed for local development.

Apply the schema before starting the application:

```bash
npm run db:migrate
npm run dev
```

For the first administrator only, set `BOOTSTRAP_ADMIN_TOKEN` to a random secret of at least 32 characters. Open the app and submit that token with the administrator account details. Remove the token from the deployment configuration after setup. Administrators can create additional local accounts from the inventory workspace.

Passwords must be at least 14 characters and include uppercase and lowercase letters, a number, and a symbol. Administrators can disable or enable accounts and revoke sessions from the inventory workspace; disabling also revokes existing sessions. The last active administrator cannot be disabled. Database backups, TLS, PostgreSQL access controls, secret rotation, and operational hardening remain deployment responsibilities. The application does not provide offline mutation queues or claim regulatory compliance.

The initial cloud domain is `cloudforge.live`. The Railway production service must set the server-side `APP_ORIGIN=https://cloudforge.live` and `NEXT_PUBLIC_APP_URL=https://cloudforge.live`. `APP_ORIGIN` is the canonical browser-facing HTTP(S) origin with no path or trailing slash; it controls CSRF origin validation and is not inferred from forwarded headers. Production writes fail closed if it is missing or invalid. In development, when `APP_ORIGIN` is unset, the request URL's origin remains the default. Set `APP_ORIGIN` explicitly to the public origin for reverse-proxy, on-prem, or production-mode local deployments.

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The liveness check is available at http://localhost:3000/api/health. Check `/api/health/ready` for PostgreSQL and migration readiness.

### PostgreSQL integration tests

`npm run test:integration` runs the route handlers against a real PostgreSQL database. It requires `TEST_DATABASE_URL` and never reads `DATABASE_URL` or `.env.local`. The schema in that database is dropped and rebuilt on every run, so a safety guard (`tests/integration/database-guard.ts`) refuses to start unless all of these hold:

- the host is `localhost`, `127.0.0.1` or `::1` (hosted providers such as Railway are rejected by name);
- the database name contains a `test` segment and does not look like production;
- the role is a dedicated test role whose name contains a `test` segment;
- the URL does not match `DATABASE_URL`.

```bash
# Example: a disposable local database and role named cloudforge_test
TEST_DATABASE_URL=postgresql://cloudforge_test:<password>@localhost:5432/cloudforge_test npm run test:integration
```

GitHub Actions (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, the integration tests against a throwaway `postgres:18` service container, the production build, and a production dependency audit.

### Phase 4 equipment and simulated telemetry

Apply migration `006_phase4_equipment_maintenance_telemetry.sql` with `npm run db:migrate` after taking a database backup. The migration extends existing equipment records and adds maintenance, downtime, telemetry, and rollup tables; it does not connect to external systems. New equipment receives a simulated telemetry source and standard tags automatically. Existing equipment receives the same disconnected simulated source and tags when the migration runs.

Telemetry is generated from the equipment workspace or the authenticated `POST /api/operations/telemetry/simulate` endpoint. Supported modes are `normal`, `stopped`, `fault`, `stale`, `offline`, `out_of_order`, and `invalid`. Samples are validated and append-only; ingestion rejects observations older than 30 days and aggregates up to 5,000 retained raw samples older than 30 days into hourly rollups before removal. Reliability reporting defaults to 30 days and accepts a 1–365 day window. Availability uses the clipped union of downtime intervals; MTBF divides available time by failures that started in the reporting window; MTTR averages completed failure durations that ended in the window. Empty denominators are reported as unavailable rather than fabricated values.

There is no destructive down migration because these tables contain operational history and inventory-linked records. To roll back an application release, stop writes and restore the pre-migration database backup (or roll forward with a corrective migration); do not manually drop Phase 4 tables from a database containing records that must be retained. Cloud, on-prem, local, and air-gapped deployments use the same local simulator and require no telemetry SaaS or internet connection.

## Container build

The project includes a standalone Next.js container path suitable for cloud or on-prem orchestration:

```bash
docker build -t cloud-forge:local .
docker run --rm -p 3000:3000 -e DEPLOYMENT_MODE=local -e APP_ORIGIN=http://localhost:3000 -e DATABASE_URL=postgresql://cloudforge:change-me@host.docker.internal:5432/cloudforge cloud-forge:local
```

Run schema migrations as a controlled deployment step with a migration-capable database role: `docker run --rm --env-file .env.local --entrypoint node cloud-forge:local scripts/migrate.mjs`. Keep the application database role least-privileged for normal runtime; provision a separate role for migrations.

Production deployment still requires secrets management, logging, backups, network controls, password recovery, and a formal security/compliance process. Local password authentication includes per-identifier login throttling and administrator session revocation, but does not yet include MFA or password recovery. Failed and throttled login attempts are recorded in the append-only audit log without attributing them to a user; the normalized identifier is hashed, not encrypted, and may be guessable. Protect audit data and monitor storage growth. This repository does not claim DoD, NIST 800-171, CMMC, or DFARS compliance by itself.

## Next.js resources

- https://nextjs.org/docs
- https://nextjs.org/learn
