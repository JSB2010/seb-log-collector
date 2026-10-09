# Acceptance and evidence boundaries

No school-wide rollout is implied by building or deploying the server. Use synthetic fixtures until a restricted managed-Mac pilot is approved and tested.

## Automated checks

- Server build/type checks and pinned dependency audit.
- Exact 32-byte credential vector, automatic/conflicting enrollment, explicit group closure, saved-credential recovery and revocation.
- Device/admin separation, current admin permission, CSRF and unsafe production-default rejection.
- Automatic Jamf-group acceptance without a serial roster, concurrent enrollment ceiling, closed/deleted bootstrap denial, deterministic combined installer and persistent private offline enrollment retry.
- Concurrent reservation/daily accounting, durable completion/deduplication, immutable metadata and no retention extension.
- Corrupt hashes, sizes, wrapper/trailer, concatenated members, trailing payloads and excessive expansion rejected.
- Exact application cutoff before physical deletion, cleanup references preserved when deletion fails.
- Native macOS JSON, SQLite, stable descriptor snapshots, spaces, symlink/hard-link/FIFO rejection, gzip and plist checks.
- Native snapshot-to-acknowledgment collection with apostrophes, backslashes, Unicode and SQL-like metadata; orphan recovery/expiry, payload preservation on ledger write failure, safe error output and confirmed-source deduplication.
- Repeated installer retrieval, encrypted bootstrap omission from lists, legacy one-time rotation, reopen preserving credentials/counts, and descending cursor pagination with timestamp ties.
- Readable native lifecycle fixtures: offline repair, equal-version update, downgrade rejection, manifest/path/hash rejection, verified update, preserved state, and removal; network/launchd/process controls are mocked in this fixture.
- Stable release fixtures: 1.0.0 installer rerun on 1.0.1 preserves the newer binary, recovery files, credentials, staging, pause and daemon; a scoped stale installer reconciles enrollment with the newer collector; truncated markers recover from binary version; unknown versions and wrong interpreters fail before replacement. Artifact generation is deterministic, checksums cover every asset, and tags must match source versions.
- Local API smoke and browser checks for fleet, pause/resume, collection requests, enrollment and live admin management.
- A 1,000-device synthetic memory cohort verifies enrollment, reporting, and complete cursor pagination. It does not certify Cloud Run throughput, concurrent live uploads, or managed fleet capacity.

## Real cloud checks

Prove a private exact-length POST upload, effective create-only signer, overwrite/read denial, wrong-key and wrong-size rejection, accepted-generation byte-identical admin retrieval, repeat preparation with no additional object/quota charge, revoked completion denial, authenticated Scheduler operation, and accelerated expiry/cleanup using explicitly synthetic records.

Emulators and local verification cannot establish these provider behaviors. A forged operator test session can exercise admin routes but does not establish a completed Google browser sign-in. Test actual Google login with an allowed admin and a nonadmin school account after configuring the web client.

The operator-only cloud harness accepts `TEST_ORIGIN`, `TEST_BUCKET`, `GCP_PROJECT`, and `GCP_ACCOUNT`. Run `node tests/cloud-smoke.mjs` using an explicitly authorized project/account. On macOS, adding `TEST_NATIVE_MAC=1` also exercises the collector's real curl configuration, native JSON parser, enrollment reconciliation, and multipart upload with a space in the file path. It uses an isolated ignored fixture directory and synthetic content; it does not install launchd or scan user logs. The operator must already have access to the session signing secret and Firestore; the harness binds its short-lived test session to that operator's verified Google identity. Remove synthetic records after inspecting Scheduler cleanup. Keep browser OAuth evidence separate.

## Managed Mac pilot gates

1. Five to ten Macs: actual Jamf install, enrollment, standard/logged-out/multiple users, permissions, macOS 13+ and current fleet versions, Intel/Apple silicon as present.
2. Stable and changing log snapshots, lost upload/completion responses, reboot, offline retries, disk/staging caps, hostile path swaps against root-only/other-user files and bounded child termination.
3. Daily catch-up, sleep/wake and battery/resource measurement; deferred request during a real AAC exam without settings changes.
4. Update preserving credentials/pause/staging/ledger, failed-update recovery, offline/in-upload/partial/repeated uninstall, reboot absence and ordinary SEB exam launch afterward.
5. Measured storage bytes, API reads/writes, CPU/memory, failures and download volume; then expand to 25–50, 250, and the remainder only after inspecting an actual exam and following daily collection.

Custom directory support and device-specific limit overrides are not implemented in the initial collector. The standard directory and documented hard limits must match the pilot. Source logs are not authenticated evidence. Privacy/launchd/Jamf checks and the full architecture/version matrix must be reported as pending until actually run.

Remote lifecycle regression checks cover pinned artifacts, command ownership, single pending command, cancellation, pause-independent check-in, exam deferral, teardown-only result access after revocation, exact installed-version acknowledgment, bulk replay and partial unsupported-device results. Native worker fixtures execute same/newer upgrades, checksum/downgrade/transport/install failures, successful/failed removal and credential cleanup with isolated transport/launchd controls. Actual transient launchd delivery on a live Mac remains a distinct acceptance stage.
