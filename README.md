# Cloud Forge

Cloud Forge is a deployment-neutral operations platform beginning with the Phase 1 inventory foundation. It is designed to run in cloud, customer-managed on-prem, air-gapped, and local environments from the same application release.

The current inventory workspace is a frontend prototype. Real inventory data, authentication, authorization, audit persistence, and synchronization are backend work that must be completed before production use.

See [docs/architecture.md](docs/architecture.md) for the deployment model, backend sequence, and compliance boundaries.

See [docs/frontend-product-blueprint.md](docs/frontend-product-blueprint.md) for the frontend information architecture, role workspaces, interaction patterns, AI surfaces, and build order.

## Development

Install dependencies and run the development server:

```bash
npm install
npm run dev
```

Open http://localhost:3000 in your browser.

Copy `.env.example` to `.env.local` when you need to select a deployment profile. No domain is needed for local development.

The initial cloud domain is `cloudforge.live`. Set `NEXT_PUBLIC_APP_URL=https://cloudforge.live` in the cloud deployment environment. Keep the local value as `http://localhost:3000` during development and use the customer-provided URL for on-prem deployments.

## Validation

```bash
npm run lint
npm run typecheck
npm run build
```

The runtime health check is available at http://localhost:3000/api/health.

## Container build

The project includes a standalone Next.js container path suitable for cloud or on-prem orchestration:

```bash
docker build -t cloud-forge:local .
docker run --rm -p 3000:3000 -e DEPLOYMENT_MODE=local cloud-forge:local
```

Production deployment still requires an approved identity provider, database, secrets management, logging, backups, network controls, and a formal security/compliance process. This repository does not claim DoD, NIST 800-171, CMMC, or DFARS compliance by itself.

## Next.js resources

- https://nextjs.org/docs
- https://nextjs.org/learn
