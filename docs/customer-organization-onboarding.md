# CloudForge customer organization onboarding and licensing runbook

**Staged workflow only.** This procedure must not be used with a paying
customer until `docs/commercial-release-gates.md` is signed off.
License and administrative access are independent: a valid license does
not authorize access to another company's data.

## 1. Record customer and deployment choice

Record the licensed business entity, authorized customer administrator,
deployment address/site, supported modules, seat count, license start and
expiry, support contacts and contract. Choose exactly one deployment type:
`saas`, `dedicated`, `on_premises` or `air_gapped`.

A shared cloud organization uses the centrally controlled multi-tenant
runtime. A dedicated, on-premises or air-gapped customer should receive its
own infrastructure and backups, and its own signed license. Never use one
company's organization ID, license, data or passwords for another company.

## 2. Provision organization — platform owner only

Commercial activation must already be reviewed and recorded. In the platform
owner administration screen, register the company name, unique short
identifier and deployment type. This creates its own organization record.
Creating a new organization does **not** enroll the platform owner into
the customer's operational membership.

Document the assigned organization UUID and deployment inventory.

## 3. Issue a signed, customer-specific license

On a trusted vendor-only machine, create a license request JSON with the
actual assigned organization UUID, purchased modules and seat count.
For example, replace all placeholders with approved contractual values:

```json
{
  "organizationId": "00000000-0000-4000-8000-000000000001",
  "licenseType": "on_premises",
  "tier": "professional",
  "seatLimit": 20,
  "modules": ["inventory", "projects", "engineering", "production", "purchasing", "field_service", "equipment", "telemetry"],
  "expiresAt": "2027-12-31T00:00:00.000Z"
}
```

A sample UUID is **not** a valid customer provision; use the exact UUID
from step 2. Run the issuer on the secured vendor machine only:

```sh
CLOUDFORGE_LICENSE_SIGNING_KEY_FILE=/secure/ed25519-private.pem \
  node scripts/issue-license.mjs customer-request.json signed-license.json
```

The private Ed25519 signing key must never enter CloudForge's app server,
customer premises or any connected/air-gapped installation. Deliver only
the signed license JSON and public verification key over an approved channel.
The customer-side license installation is platform-owner authenticated and
must validate the organization UUID and signature.

## 4. Invite the customer administrator

Use the platform owner's organization-invitation action to send a one-time,
short-lived invitation to the **intended customer administrator**. Provide
the link privately. The customer enrolls or verifies their account, accepts
the invitation and signs in. The customer administrator uses the MFA setup
screen to register a real authenticator and save the one-time recovery codes.

The customer admin may then manage its own licensed members. Test the seat
limit and verify unrelated organizations' members and invitations are absent.
A suspended organization must not be able to access operational records.
Never resolve a customer's recovery need by granting a different customer's
administrator access to the account.

## 5. Verify purchased modules and engineering workflows

Using synthetic sample records and the customer site configuration:
- Register one project and its equipment from the same engineering upload UI.
- Directly upload **PLC code**, **HMI code**, **electrical schematics** and
  **mechanical schematics** as their original vendor files.
- Verify checksum, scan outcome, initial draft status, revision history and
  administrator release approval. Test an unauthorized staff member and an
  unrelated company cannot download those files.
- Assign a field-service job and confirm only authorized, assigned technicians
  can download the approved revision and record their onsite installation.
- Create inventory; issue and receive stock. Enable then disable
  **Auto Reorder** on one SKU, verify one internal purchase request is created
  when stock hits the configured point, and verify no supplier order is sent
  without purchasing approval.
- Validate equipment and live telemetry are strictly read-only by default.
  Physical PLC changes require the customer's separate onsite authorization.

## 6. Validate installation and operational recovery

For on-premises/air-gapped customers, prepare restricted database credentials,
customer-held MFA encryption key, local public license-verification key,
real malware scanner with verified signatures, customer-owned encrypted
backups and an offline restore-key escrow process. Verify TLS and network
segmentation. Do not expose the database or scanner on public ports.

Run an actual clean-room restore (not just an automated test), verify
all engineering file hashes, organization mappings, audit events, inventory,
login, license and MFA behavior, and record measured RPO/RTO.

## 7. Signoff, support and lifecycle

Obtain customer acceptance for each purchased module, support hours, SLA,
renewal and escalation. Record the customer contract, exact version, image
digest, maintenance window, contact procedures, backup retention, incident
handling and eventual export/deletion requirements.

Renew licenses by issuing a **new, later** signed license from the vendor
machine and installing it for exactly the customer's organization. Do not
replace a customer-specific license with a shared all-organizations key.

If all conditions are not met, do not mark the deployment commercial-ready.
