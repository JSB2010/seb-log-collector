# Diagnostics integration v2

`/api/integration/v2` preserves the existing collector, device APIs, private bucket, native releases and administrator console. No enrollment, update, uninstall, fleet commands or administrator management are exposed through this integration.

Set `INTEGRATION_CLIENTS` to a JSON object keyed by registered client ID. Each value contains exact HTTPS `origin`, `webServiceAccount`, `workerServiceAccount`, and allowed `installations`. The dashboard callback is exactly `origin/api/auth/callback`. Web and worker call with Google-signed OIDC for audience `PUBLIC_ORIGIN/api/integration/v2`; investigator calls also carry the verified actor in `x-soe-actor`. Every request rechecks the current active administrator record and Google subject.

- `GET auth/authorize`: existing administrator Google login, registered callback, state and S256 PKCE; two-minute single-use authorization code.
- `POST auth/exchange`: registered web service identity, atomic code use and PKCE verification.
- `POST authorize`: current investigator authorization check.
- `GET logs`: incremental since/until window with stable cursor and bounded pages.
- `POST logs/reindex`: worker-only five-file parser backfill, bounded retries. Parser failure does not reject otherwise verified uploads.
- `GET logs/:id`, `GET logs/:id/content`, `POST logs/:id/search`, `GET logs/:id/download`: retained metadata, verified sanitized viewing, bounded search and explicit audited originals. Contents remain client-reported evidence; stored GCS generation and integrity are verified before reads.
- `GET devices`, `POST devices/:id/requests`, `GET requests/:id`: select a device, request at most a 24-hour collection window, observe native protocol status. Stable UUID operation IDs make retries idempotent; requests are limited per investigator.
- `POST session-links`: audited manual association/removal. Markers are non-secret correlation, not authentication. A hostname or local username never identifies a Canvas learner.

Protocol v1 and synthetic fixtures are vendored in `contracts/`. Parsing records parser version, line references, bounded findings and markers. Filename times stay UTC; ambiguous local line timestamps retain uncertainty. Original files stay in existing private storage and cannot be read after collector expiry. This backend deployment does not update native collector binaries or fleet configuration.

Verification: existing unit/security tests plus `tests/integration.test.ts` cover exact callbacks, PKCE replay, actor revocation, OIDC identity denial, cross-installation denial, idempotent bounded collection, immutable bytes, redaction, expiry and original-download auditing.
