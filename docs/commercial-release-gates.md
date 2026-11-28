# CloudForge commercial release decision — go/no-go checklist

**Current decision: NO-GO.** The working branches contain substantial release
controls and automated tests, but a green CI build is NOT production/customer
authorization. This checklist is the evidence register for a documented
launch decision, not a declaration of compliance or certification.

## Product and licensing scope

CloudForge is a deployment-neutral industrial operations/ERP platform with:
- Shared multi-organization cloud SaaS (independent tenant membership, signed
  license, seat and module entitlements, data isolation)
- Dedicated cloud installation
- Customer-managed on-premises installation
- Customer air-gapped installation with locally verifiable offline license

**All organizations must have individual licenses.** Platform owners provision,
sign and install customer licenses; they must never gain customer operational
membership merely by creating the organization. Customer admins manage their
own users. Tenant suspension must affect only its organization, and account
recovery must not give an unrelated organization's administrator access.

The engineering library includes direct upload and controlled revisions for
**PLC code, HMI code, electrical schematics and mechanical schematics**, plus
equipment registration on the same screen. Controlled field-service downloads
must not be confused with authorization to make live PLC changes. Auto Reorder
is an optional per-item **ON/OFF** feature that creates internal purchasing
requests; outside purchasing needs separate human approval.

## Automated technical evidence

Automated passing tests demonstrate implementation behavior, not a complete
security audit. Confirm that the HEAD commit being released matches the
tested commit, and preserve GitHub Actions run evidence.

- [ ] Consolidated release-candidate CI: lint, TypeScript, unit, dependency
  audit, production build, disposable PostgreSQL integration tests and actual
  on-prem container smoke tests all pass on the **same SHA**
- [ ] Commercial activation preflight on a non-production database
- [ ] Two *separately licensed* organizations with the **same SKUs** and
  deliberately crossed IDs, testing zero leakage of inventory, users, projects,
  engineering binary files, purchasing, telemetry and audit records
- [ ] Restricted PostgreSQL `NOSUPERUSER NOBYPASSRLS` account and FORCE RLS
  enforcement on all customer-owned tables
- [ ] Individual signed-license seat limits, module entitlements, expiry,
  renewal, suspension and offline signature validation; test negative paths
- [ ] MFA enrollment, authenticator sign-in, code replay rejection and
  one-time recovery codes; verify operational access is blocked without MFA
- [ ] File upload/download hash integrity and malware detection; verify
  all four engineering file categories and existing revisions
- [ ] Per-item Auto Reorder off by default, one open request maximum,
  no duplicate on transfers, disable without destroying existing requests
- [ ] Restored disposable database retains engineering-file bytes, inventory,
  audit history, membership records and installed licenses

## Mandatory human and environment acceptance

These items cannot be asserted merely from an automated repository test:

- [ ] Independent security penetration test of authentication, recovery,
  authorization, organization switching, SQL/RLS boundaries, app routes,
  file uploads/downloads, dependency/supply-chain vulnerabilities and CSRF
- [ ] External reviewer signs off all unauthenticated endpoints and Phase 1–5
  customer data access, including OPC UA gateways, alarms and telemetry
- [ ] Full staging test with **real ClamAV signatures**, a harmless EICAR
  test file, scanner downtime, offline signature update, 50 MB files and
  approved industrial vendor project archives
- [ ] Two-organization staging dry run under the same database connection
  pooling, session rules, load balancer and authentication configuration
  planned for production; test concurrent and aborted transactions
- [ ] Customer-safe recovery procedure for lost MFA device plus all recovery
  codes, lost password, lost AES secret, and compromised signing keys,
  with dual approval and immutable incident evidence
- [ ] Run actual encrypted `age` backup and **separate site recovery**
  using customer-held keys; measure RPO/RTO and verify signed licenses,
  restored MFA functionality and every engineering file checksum
- [ ] Review access-controlled off-site backup retention, daily backup
  alerts, periodic restore drills, key rotation and secure deletion
- [ ] Deployment image digest pinning, signed checksums/SBOM, vulnerability
  scanning and a tested rollback to a separately backed-up release
- [ ] Dedicated cloud, on-prem, and truly air-gapped installation tests;
  prove air-gap needs no online license server, cloud telemetry or
  unauthorized outbound calls; verify protected OT network boundaries
- [ ] Site-specific PLC/SCADA cybersecurity review, read-only telemetry
  default, network segmentation, MFA for remote support, separate approval
  for onsite programming/write actions, full activity logs
- [ ] Observability: health and security alerts, on-call owner, audit retention,
  license expiry notification, customer-isolated error reporting and
  reliable backup/restore alerting
- [ ] Usability acceptance with customer engineers: create project/equipment,
  upload a PLC program and HMI program, upload both schematic types, approve
  revision, field technician download, record installation; exercise
  inventory replenishment ON and OFF
- [ ] Sales/legal signoff: SaaS Terms, per-site commercial license,
  privacy policy, DPA (where applicable), confidentiality/security addendum,
  export/disaster-recovery clause, support SLA, pricing/renewal/refunds,
  data ownership and retention, incident notification and termination terms
- [ ] Customer acceptance tests signed by a pilot customer and commercial
  release owner, including rollback and export/recovery scenarios

## Explicit production authorization

1. Freeze and tag the fully reviewed code SHA; capture all test evidence.
2. Back up the currently running production installation independently and
   prove its restore path; never copy production data into an unsecured test.
3. Obtain written release-owner approval for the exact environment and
   requested activation. A general request to work toward commercial readiness
   **is not approval to merge, deploy, change production databases or remove
   the singleton organization guard**.
4. Only then run the controlled `scripts/activate-multiorg.mjs --audit`
   and review its findings, and separately authorize any `--apply` procedure.
5. Deploy with the exact tested security and licensing environment settings,
   live scanner, MFA encryption key and restricted database role; verify
   readiness stays closed when any required component is absent.
6. Run two-tenant and real customer smoke tests, monitor, and use a documented
   rollback/incident process if acceptance fails.

Until these checks are explicitly signed off: **NO MERGE, NO PRODUCTION
ACTIVATION, NO CUSTOMER LICENSING AS A FINISHED PRODUCT.**
