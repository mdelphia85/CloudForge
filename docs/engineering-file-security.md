# Engineering file security — PLC, HMI, electrical and mechanical schematics

Status: **staged commercial security work**, not a production activation.

CloudForge stores user-supplied engineering files as **opaque binary data**. It
does not execute a program, open a proprietary PLC/HMI project in-process,
render embedded code in a browser, or transfer a program into an operating PLC.
Uploads/downloads remain separate from the restricted read-only OT telemetry
and customer-controlled onsite programming approval process.

## Upload controls

Both the direct engineering upload and later revision-upload routes enforce
the same filename and active-content restrictions. A 50 MB limit remains in
effect; supported proprietary file formats are not rewritten or unpacked.
Files are associated with the authenticated organization's project/equipment,
revisioned, SHA-256 checksummed, and audited.

**Commercial mode requires malware scanning before accepting any bytes.**
CloudForge streams bytes via ClamAV `clamd`'s INSTREAM protocol to a
*customer-controlled, private-network scanner*. The server must report
`stream: OK` to accept the file. Malicious, timed-out, unavailable, and
unexpected responses fail closed: no document or revision is committed.
The original bytes are never sent to a public or third-party API.

Required application environment for the commercial scanner:

- `CLOUDFORGE_CLAMAV_HOST`: an internal DNS name or private host address
  reachable only from the application network
- `CLOUDFORGE_CLAMAV_PORT`: clamd TCP port (normally `3310`)
- `CLOUDFORGE_ENGINEERING_MALWARE_SCAN_REQUIRED=true` when testing the
  security gate without enabling multi-organization licensing

A production license/tenant session automatically forces scanning regardless
of the optional testing flag. Commercial readiness also requires a successful
ClamAV `PING` / `PONG` exchange.

**Keep port 3310 inaccessible to users and the internet.** Only the application
should reach the scanning daemon. Confirm local TLS/network boundaries,
signature currency, file-size/stream limits, antivirus detection policies and
failure alerts before customer onboarding. For air-gapped sites, transfer and
verify vendor-approved scanner signatures through the site's documented
offline update process; internet access is not required by CloudForge.

## Download controls

Downloads verify stored bytes against original byte count and SHA-256 digest.
A corrupt or modified revision fails closed. Commercial downloads are scanned
again, including revisions that predate adoption of the scanning feature.
Files are always returned as `application/octet-stream` attachments with
`nosniff` and `no-store`; no browser preview or code execution is allowed.
Existing organization, approved-release and assigned-technician authorization
checks remain in effect.

## Limits and release prerequisites

ClamAV does not guarantee detection of all malicious proprietary programs.
This feature does not inspect programmable logic safety or certify changes
to industrial equipment. Human engineering-review and onsite installation
approval remain mandatory.

The current 50 MB in-memory upload path is deliberately bounded. For
larger industrial projects, a separate streaming private object-storage
design with encrypted backups, checksum verification and scanned quarantine
must be implemented before increasing the size limit.

CI uses a disposable protocol-compatible scanner to exercise CLEAN/FOUND and
request handling; that mock is **not a malware detection engine**. Real ClamAV
interoperability, up-to-date signatures and a test using the harmless standard
EICAR scanner-test string must be verified in a customer-like staging site.
