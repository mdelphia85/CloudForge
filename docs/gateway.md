# Customer-managed industrial gateway

The gateway is a separate Node.js 24 process under customer control. It performs only OPC UA value reads for explicitly mapped nodes. It does not browse for production data, write PLC values, issue machine commands, transfer programs, or reset safety systems. Existing engineering uploads, approvals, technician downloads, and onsite installations using manufacturer tools remain separate and unchanged. CloudForge alarms are advisory and are not safety interlocks.

No physical equipment has been connected or tested. The gateway is disabled unless `enabled` is explicitly `true`. Obtain site OT/IT and owner authorization before enabling any physical endpoint. Use a server-enforced read-only OPC UA identity and node permissions; the gateway cannot enforce a PLC server's access controls. The local automated test server binds to loopback only.

## Installation and placement

Install Node.js 24 and the gateway's locked dependencies with `npm ci --prefix gateway`. In an air gap, transfer a reviewed release, Node runtime, and a verified local npm mirror/cache into the isolated environment; the running gateway and CloudForge require no external SaaS or internet connection. Run the gateway under a dedicated least-privilege service account with access only to its own configuration, keys, trust store, queue, approved OPC UA endpoint, and CloudForge HTTPS endpoint. Restrict its filesystem with OS permissions; encrypt the volume where required. On Windows, explicitly set restrictive ACLs: POSIX file modes are not sufficient.

Place the gateway in a controlled OT/IT boundary, permit outbound traffic only to the configured endpoint and CloudForge, and avoid inbound OT access or exposing the OPC UA server to the internet. Use a trusted TLS certificate for CloudForge, including its hostname. For a private CA, provide `NODE_EXTRA_CA_CERTS` to Node at process startup. Never disable TLS verification. Plain HTTP is accepted only for an explicitly enabled loopback test endpoint and must not be used in production.

## Identity, trust and enrollment

1. Generate a new signing key pair on the gateway host: `npm --prefix gateway run keygen -- <protected-key-prefix>`. The private key is written with exclusive creation and restrictive POSIX mode; set Windows ACLs separately. Never send the private key to CloudForge or paste it into a browser. Keep it out of logs, backups accessible to other users, and source control.
2. Obtain the OPC UA server's certificate through a trusted offline channel. Verify its SHA-256 fingerprint independently, put the certificate in the gateway's `trustStore/trusted/certs` directory, and configure that exact 64-hex-digit fingerprint. Install the gateway's client application certificate and private key and configure the matching application URI. The OPC UA server must separately trust that client certificate and grant only read access. Certificate expiry, revocation lists, and trust-store maintenance are site responsibilities.
3. If the OPC UA server requires a username identity, store `{"userName":"...","password":"..."}` in a separate access-restricted local JSON file and set `identityFile`. The gateway requires the trusted encrypted token policy when using a username. Avoid anonymous access on production devices.
4. As an administrator, select equipment in the equipment workspace, register the **public** Ed25519 PEM key, an expiration time, and the explicit allowed tags. Copy the returned gateway ID into the local configuration. Only administrators can register, disable, enable, rotate, or revoke a gateway. No private key is sent to the browser or server. A gateway can be authorized for several assets by using the registration API with their tag IDs; the workspace form registers tags for the selected asset. Each asset has at most one gateway source.
5. Configure the local allowlist with the exact asset UUID, registered tag name, OPC UA node ID, and matching `number`, `boolean`, or `string` type. Data not matching a configured mapping is never polled. Ensure the server-provided source timestamp is present and both gateway and CloudForge clocks are synchronized.

Create a protected JSON configuration file outside the repository. This is a structure example, not a physical equipment endpoint:

```json
{
  "enabled": false,
  "gatewayId": "00000000-0000-4000-8000-000000000000",
  "cloudforgeUrl": "https://cloudforge.example",
  "signingKeyFile": "/protected/gateway.private.pem",
  "queueFile": "/protected/telemetry.sqlite",
  "queueMaxItems": 10000,
  "queueMaxBytes": 50000000,
  "pollIntervalMs": 5000,
  "deliveryTimeoutMs": 10000,
  "opcua": {
    "endpoint": "opc.tcp://approved-host.example:4840",
    "trustStore": "/protected/opcua-pki",
    "certificateFile": "/protected/opcua-client-certificate.pem",
    "privateKeyFile": "/protected/opcua-client-key.pem",
    "applicationUri": "urn:customer:cloudforge-gateway",
    "serverCertificateSha256": "REPLACE_WITH_64_HEX_DIGITS",
    "identityFile": "/protected/opcua-identity.json",
    "timeoutMs": 10000,
    "mappings": [
      { "assetId": "00000000-0000-4000-8000-000000000000", "tagName": "temperature_c", "nodeId": "ns=2;s=Temperature", "dataType": "number" }
    ]
  }
}
```

Omit `identityFile` only if the OPC UA server intentionally permits anonymous read-only sessions. Replace example values, provision both sides of certificate trust and the allowed tags, then explicitly enable only after site authorization. Start with `npm --prefix gateway start -- <configuration-file>`. The gateway will not start collecting if certificate trust, fingerprint, configuration, or enrollment is wrong.

For rotation, create a new key pair locally, update the public key and expiry through the administrator interface, then replace the local signing key path. Rotation invalidates the old key immediately and the queue is retained. Disabling or revoking a gateway blocks ingestion immediately; revocation is permanent. After revocation, an administrator can enroll a replacement gateway for the equipment, retaining source and alarm history. Expired credentials cannot ingest; rotate them before enabling. Securely dispose of old keys according to site policy.

## Buffering, diagnostics and recovery

Each persisted batch receives a monotonically increasing sequence. The queue is stored in SQLite with full synchronization and WAL; retry uses exponential backoff up to 60 seconds. A batch remains queued until CloudForge returns a matching acknowledgement. Replays use the same body and sequence; the server records the payload hash and rejects sequence reuse with different content. Late sequences and old observations are retained as out-of-order rather than used to trigger or clear alarms. Samples over 30 days old, clocks over 30 seconds ahead, invalid values, unknown tags, and invalid signatures are rejected. Signed request timestamps have a two-minute clock-skew window.

The configured queue limits bound queued payload count and bytes, not SQLite/WAL filesystem overhead. Provision a separate monitored disk quota and alert on errors, queue growth, certificate expiry, and disconnection. When full, the gateway does **not** overwrite pending entries; polling attempts fail visibly. Measurements occurring while the queue is full cannot be recovered unless the OPC UA server provides a separate historical source. Corrupt entries and rejected batches block delivery rather than being silently dropped; stop the gateway, preserve the queue and logs, correct the cause, and restart. Do not edit the database or delete an entry to make the status look healthy.

Back up the queue consistently with SQLite's backup procedure, including its WAL state, while the gateway is stopped or using an online SQLite backup tool. Preserve the private key securely and separately. Restoring an older queue snapshot may reuse a sequence already committed by CloudForge and will be rejected if its content differs. If queue state or sequence history is lost, stop the old gateway, retain evidence, revoke it, and enroll a new identity for the asset; unrecoverable unforwarded samples must be reported as lost, never fabricated.

Connection and observed timestamps are shown separately in the equipment workspace. A stale, delayed, invalid or disconnected sample is not live; replaying buffered samples does not make an old observation current. Gateway events and alarm transitions identify the gateway principal. The simulator remains available and does not trigger gateway-source alarms once a gateway source exists. No telemetry automatically creates production downtime.

## CloudForge database recovery

Take and test a PostgreSQL backup before applying migration `010_phase5_industrial_gateways.sql`. Migrations are additive and retain existing telemetry and alarm history. For a failed migration, stop writers, inspect the migration transaction and logs, restore a tested pre-migration backup or roll forward with a corrective migration. Do not drop telemetry, queue, alarm, audit, or inventory history as a shortcut. Restoring a database backup can lose accepted sequence records after the backup; coordinate gateway queues and database recovery so replay does not duplicate or silently omit accepted operational data.

Run `npm test --prefix gateway` for the loopback OPC UA server, trust, buffering, and delivery tests. GitHub CI runs the application integration suite only against its disposable PostgreSQL service. This does not substitute for customer site acceptance, network security review, or verification against authorized physical equipment.
