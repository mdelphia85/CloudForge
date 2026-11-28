# CloudForge on-premises / air-gapped deployment (engineering preview)

**Commercial release status: NOT READY.** This is a portable deployment foundation,
not approval to license customer data or run unattended industrial sites.
Multi-organization isolation, enforced subscription/seat/entitlement rules, MFA,
documented backup/restore testing, and production acceptance remain outstanding.

## Architecture

One CloudForge web container, one short-lived privileged schema-migration
container, and one PostgreSQL 18 database in a private Docker Compose network. Database storage is a named persistent volume, not an
ephemeral container filesystem. A local reverse proxy supplies HTTPS and the
site origin is configured explicitly; Railway, Squarespace, and internet access
are not required at runtime.

The existing organization singleton guard remains active until all operational
APIs, file downloads, audit rows, telemetry and gateway paths can prove
cross-organization isolation. Do not remove it to serve multiple customers.

## Preparation (authorized administrator)

1. Use a current patched host with Docker Engine + Docker Compose v2.
   Restrict host administrative access, physical ports and backup access.
2. Create local `secrets/` next to `compose.yaml`. It is ignored by Git and Docker build.
3. Store two **different cryptographically random 24+ character** database passwords in
   `secrets/postgres-admin-password.txt` (schema migrator only) and
   `secrets/postgres-app-password.txt` (the web app). The web application is
   configured as PostgreSQL `cloudforge_app` with `NOSUPERUSER NOBYPASSRLS`
   privileges; never give it the schema-owner password.
4. Store the **Ed25519 PUBLIC** verification key (PEM) in
   `secrets/license-public-key.pem`. The corresponding PRIVATE license signing
   key must **never** be installed on this server.
5. On first administrator setup only, create a random **32+ character** token in
   `secrets/bootstrap-admin-token.txt`. Remove the bootstrap secret mount and
   `BOOTSTRAP_ADMIN_TOKEN_FILE` variable from the local Compose configuration
   after the account exists, then securely delete the token file.
6. Set `APP_ORIGIN` to the exact URL that end users visit, including
   `http://localhost:3000` only for isolated testing, or an internally managed
   HTTPS hostname for production. Reverse proxy TLS is the deployment owner's
   responsibility. By default the service listens on host loopback only;
   expose it through a hardened TLS reverse proxy on the same host.

Configure and test the HTTPS endpoint, database backups, disaster recovery
and restore process before bringing real engineering records onto the system.

## Build and test on a connected staging machine

```sh
APP_ORIGIN=http://localhost:3000 docker compose build
APP_ORIGIN=http://localhost:3000 docker compose up -d --no-build
docker compose ps
```

Open the configured origin; use the one-time administrator setup flow and
remove the bootstrap token after setup. Confirm login, read/write stock
transactions, project creation, and safe PLC/HMI file download/upload against
non-customer sample files. Do not connect production machinery during tests.


### Database role boundary

`cloudforge-migrate` applies migrations using the separately protected
`cloudforge_admin` database password and provisions a restricted
`cloudforge_app` role. The web container receives only the latter credential;
it cannot run administrative schema migrations or bypass PostgreSQL row-level
security as a superuser. The database volume remains persistent across restarts.

Do not enable the `CLOUDFORGE_MULTI_ORGANIZATION_ENABLED` production flag
until every API path, file repository, license policy, and industrial gateway
isolation test is green and the database role has been confirmed
`NOSUPERUSER NOBYPASSRLS`. The app readiness check is an additional
fail-closed protection and does not replace a complete security review.

## Air-gapped installation

Build and validate the exact application image on a controlled staging machine
with a documented bill of materials and integrity hashes. Transfer images using
a trusted, malware-scanned removable medium as permitted by site policy.

```sh
docker save cloudforge-onprem:local postgres:18 -o cloudforge-images.tar
# Copy tar to approved offline site, check its hash, then:
docker load -i cloudforge-images.tar
APP_ORIGIN=https://cloudforge.internal.example docker compose up -d --no-build --pull never
```

The site must already have the trusted app and PostgreSQL images locally.
Application migrations and license signature verification do not need an online
license service. If outbound networking is prohibited, enforce that requirement
at the physical firewall/host network policy. Merely being called "air-gapped"
or running Docker does not guarantee physical isolation.

## Per-organization offline licenses

The owner-side script `scripts/issue-license.mjs` signs an organization's
license on a **separate secured vendor machine** using a private Ed25519 key.
The customer receives only a signed JSON license and its public verification
key. An authorized platform owner installs the JSON on the target instance.

**At this development stage license installation exists, but complete server-side
enforcement is not yet wired to all operations.** Do not sell or deploy it as a
finished license-controlled product.

## Backup and recovery requirements

- Back up PostgreSQL with an authenticated, encrypted, access-controlled
  mechanism (consistent logical or physical backups), retain off-host copies,
  and regularly perform a restore to a separate recovery environment.
- Validate the restored organization IDs, engineer programs, file hashes,
  revision approvals, inventory movements and audit history before relying on it.
- Back up configuration, public verification key, signed licenses and documented
  database schema version. Keep private signing keys off customer installations.
- Always validate migrations in staging; take a tested backup immediately before
  upgrading a customer site. Roll forward safely or restore the previous state;
  do not blindly reverse schema changes or delete industrial records.
- Document recovery time objectives, update windows, support access, incident
  response, retention, account recovery and key rotation per customer.

## Automated recovery smoke test

GitHub CI now builds the on-premises stack, creates the first admin account,
adds sample inventory and an opaque PLC binary revision, takes a disposable
PostgreSQL custom-format dump, and restores into a **different temporary
database**. It verifies original migration versions, the inventory record,
and the exact PLC binary bytes after restoration. Both databases are destroyed
by the CI job. This test never reads production credentials or real customer
records.

This validates schema/data round-trip functionality only. **It does not make
unencrypted production dumps acceptable** or prove disaster recovery readiness.
Customer installations must use individually protected encrypted backups,
retention and off-site copies governed by site policy; regularly conduct
separate restore exercises, verify app login and engineering file checksums,
and record recovery time and recovery point objectives. Keep signing keys
outside the customer server and back up the public verification key and
license information required for a restored installation.

## Blocking work before commercial customers

- Strict cloud multi-organization isolation across **all** endpoints and links,
  including cross-tenant negative tests and least-privilege database roles.
- Per-organization server-side license enforcement on every enabled module,
  expiration/suspension policies, seat accounting and recovery/export.
- Customer onboarding, invitations, organization management, secure roles and
  active-organization switching with full module coverage.
- MFA, secure account recovery, secret rotation, database isolation and
  file security controls.
- Complete accepted PLC/HMI, electrical and mechanical schematics upload workflows,
  including size/format policies, malware controls and persistent storage strategy.
- Tested container builds, unattended restart, resource/volume handling,
  encrypted backup/restore, and offline upgrade/rollback exercises.

These are release gates, not optional improvements.
