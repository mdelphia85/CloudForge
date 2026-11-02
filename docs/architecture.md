# Cloud Forge architecture baseline

## Product boundary

Cloud Forge is being built as one deployment-neutral application. The same version must run in:

- Cloud-hosted environments
- Customer-managed on-prem environments
- Restricted or air-gapped environments
- Local development

A domain is not required for development or on-prem installation. DNS and TLS are deployment concerns, not application dependencies.

## Current state

The inventory workspace is backed by PostgreSQL through the `/api/inventory` and `/api/inventory/movements` route handlers. Local accounts use database-backed sessions; inventory writes are role-checked and transactionally recorded in append-only movement and audit tables. This implementation is single-organization per deployment; tenant isolation and organization switching are not implemented, so multiple customers must not share a database. Other ERP screens, industrial integrations, synchronization, and AI are not implemented. Local authentication does not yet include MFA, password recovery, session revocation, or login throttling.

## Target shape

```text
Web UI / mobile clients
          |
      HTTPS / mTLS
          |
  Cloud Forge application
  - API routes and domain services
  - authentication and authorization
  - tenant and party boundaries
  - append-only audit events
          |
  Persistence adapters
  - PostgreSQL-compatible database
  - object storage for documents and CAD files
  - queue/event transport for integrations
          |
  Deployment profile
  - cloud managed services
  - on-prem customer services
  - air-gapped local services
```

The application should depend on interfaces for database, object storage, event transport, identity, and telemetry. Cloud and on-prem profiles then provide implementations without changing inventory or work-order rules.

## AI assistance layer

AI should be an assistive layer with a strict separation between recommendations and authorized actions. The first useful capability is an explainable inventory copilot that highlights reorder risk, unusual stock movements, likely shortages, and data-quality issues. It should show the evidence behind every recommendation and require a user or approved workflow to apply any change.

Initial AI capabilities, in order:

1. Reorder recommendations based on demand, lead time, safety stock, open purchase orders, and supplier reliability.
2. Shortage prediction for projects and work orders using reservations, bills of material, and known inbound stock.
3. Anomaly detection for unexpected adjustments, duplicate scans, unusual consumption, and count variances.
4. Natural-language search over authorized inventory, work orders, documents, and audit history with citations.
5. Later: schedule, route, technician, and maintenance recommendations after those domains have reliable historical data.

The AI boundary should use a provider adapter so cloud deployments can use an approved hosted model while on-prem and air-gapped deployments can use a locally hosted model or disable generative features. Model name, version, prompt/template version, input data classification, output, confidence, citations, approver, and resulting action must be recorded. Sensitive or controlled data must never be sent to an external provider without an explicit approved boundary. AI output is advisory by default; autonomous writes require a separately approved policy, authorization, rollback path, and audit event.

The current UI labels its intelligence card as a preview because it is backed by sample data, not a production model. It must not be presented as a real prediction until the backend has historical data and an evaluated model.

## Required backend foundations before real data

1. Tenant, organization, party, user, role, and permission entities.
2. Inventory item, SKU, unit, category, location, bin, lot, and stock-balance entities.
3. Immutable inventory movement and audit-event records. Corrections should be compensating events, not destructive edits.
4. Idempotency keys for receiving, transfers, adjustments, and sync operations.
5. Server-side authorization on every read and write. UI visibility is not a security boundary.
6. Outbox/inbox records for reliable cloud, on-prem, and offline synchronization.
7. Database migrations, seed data for development, backups, restore tests, and retention policies.
8. Centralized structured logging with redaction and a documented time source.
9. AI provider, model registry, evaluation datasets, prompt versions, approval policies, and AI audit events.

## DoD and CMMC posture

This project is not yet DoD compliant. Compliance depends on the deployment, information type, contracts, authorization boundary, operating procedures, and evidence. The implementation should be designed to support controls, but it must not claim NIST 800-171, CMMC, DFARS, or DoD authorization without a qualified security and compliance review.

Security requirements to design for:

- SSO with an approved identity provider, MFA, least privilege, separation of duties, and account lifecycle controls.
- Encryption in transit and at rest, with deployment-specific key management and rotation.
- Immutable, access-controlled audit logs covering authentication, authorization, data changes, exports, and administrative actions.
- Secure configuration, dependency scanning, vulnerability management, signed builds, SBOMs, and controlled releases.
- Network segmentation, private service endpoints, backup encryption, recovery testing, and incident response evidence.
- No sensitive or controlled data in client logs, analytics, crash reports, sample fixtures, or development environments.
- Offline-first workflows with explicit conflict handling for field, manufacturing, and air-gapped deployments.

## Deployment profiles

### Cloud

Run the application and workers behind a private network or gateway. Use managed PostgreSQL-compatible persistence, private object storage, a managed secrets system, centralized logs, and a customer-controlled identity integration where required.

### On-prem

Ship the same container images and migrations. The customer supplies the cluster or host OS, PostgreSQL-compatible database, object storage, identity provider, certificates, backup target, and log destination. Installation should be repeatable without access to public package registries at runtime.

### Air-gapped

Produce a signed release bundle containing container images, SBOM, migration files, configuration schema, offline documentation, and verification checksums. Updates are imported through a customer-controlled media and approval process.

## Immediate implementation sequence

1. Add organization and tenant isolation before sharing a database across customers; cover it with authorization integration tests.
2. Add integration tests against a real PostgreSQL service, plus backup/restore and migration rollback procedures.
3. Harden local account operations with login throttling, password reset/recovery, session revocation, and account lifecycle controls.
4. Add an outbox/inbox sync engine and explicit offline conflict handling before enabling offline writes.
5. Complete deployment manifests, signed air-gapped release bundles, security scans, and operational runbooks.
6. Add the next ERP domains on the established authorization, audit, and data boundaries.
7. Perform a formal control mapping and independent assessment for the target contract and environment.
