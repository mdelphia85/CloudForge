# Cloud Forge

Cloud Forge is a deployment-neutral operations platform beginning with the Phase 1 inventory foundation. It is designed to run in cloud, customer-managed on-prem, air-gapped, and local environments from the same application release.

Inventory now uses PostgreSQL-backed records, local password accounts, server-side role checks, and transactional movement/audit history. Additional modules remain planned and are not connected to backend services.

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

Passwords must be at least 14 characters and include uppercase and lowercase letters, a number, and a symbol. Database backups, TLS, PostgreSQL access controls, secret rotation, and operational hardening remain deployment responsibilities. This initial implementation does not provide offline mutation queues or claim regulatory compliance.

The initial cloud domain is `cloudforge.live`. Set `NEXT_PUBLIC_APP_URL=https://cloudforge.live` in the cloud deployment environment. Keep the local value as `http://localhost:3000` during development and use the customer-provided URL for on-prem deployments.

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

## Container build

The project includes a standalone Next.js container path suitable for cloud or on-prem orchestration:

```bash
docker build -t cloud-forge:local .
docker run --rm -p 3000:3000 -e DEPLOYMENT_MODE=local -e DATABASE_URL=postgresql://cloudforge:change-me@host.docker.internal:5432/cloudforge cloud-forge:local
```

Run schema migrations as a controlled deployment step with a migration-capable database role: `docker run --rm --env-file .env.local --entrypoint node cloud-forge:local scripts/migrate.mjs`. Keep the application database role least-privileged for normal runtime; provision a separate role for migrations.

Production deployment still requires secrets management, logging, backups, network controls, login throttling, password recovery, session revocation, and a formal security/compliance process. Local password authentication is provided for isolated deployments; it does not yet include MFA, password recovery, or login throttling. This repository does not claim DoD, NIST 800-171, CMMC, or DFARS compliance by itself.

## Next.js resources

- https://nextjs.org/docs
- https://nextjs.org/learn
