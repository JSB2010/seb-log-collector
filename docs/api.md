# API and data contract

All API requests use HTTPS. JSON bodies are limited to 256 KiB and validated against strict typed schemas. Timestamps are UTC RFC 3339. Errors use `{"error":{"code":"...","requestId":"..."}}`. Device API version is one. Source bytes belong in GCS, never Firestore or application logs.

Device authentication: `Authorization: Bearer <installationUUID>.<base64url32ByteSecret>`. Enrollment instead supplies a short-lived bootstrap bearer and a body with `schemaVersion`, `installationId`, `serial`, `credentialHash`, and `metadata`. Hash the decoded 32 raw secret bytes, not its base64 text.

| Route                                      | Purpose                                                          |
| ------------------------------------------ | ---------------------------------------------------------------- |
| POST `/api/device/v1/enroll`               | Transactional automatic enrollment                               |
| GET `/api/device/v1/config`                | Pause state, limits, pending requests, enrollment reconciliation |
| POST `/api/device/v1/collections`          | Idempotent collection UUID / summary                             |
| POST `/api/device/v1/uploads/prepare`      | Deduplicate or reserve one immutable signed POST                 |
| GET `/api/device/v1/uploads/:id`           | Own reservation / acknowledgment status                          |
| POST `/api/device/v1/uploads/:id/complete` | Verify actual bytes and durably acknowledge                      |
| POST `/api/device/v1/requests/:id/ack`     | Received, deferred, running, completed, failed                   |
| POST `/api/device/v1/deactivate`           | Revoke own installation and cancel requests                      |

Prepare supplies `schemaVersion`, `collectionId`, optional `requestId`, raw/gzip SHA-256 and exact byte sizes, `source`, and `metadata`. The server chooses a PII-free key, reserves device/global daily volume once, and signs an exact bucket/key/type/length POST policy for ten minutes. Submit all returned literal fields, then `file` last. A failed overwrite POST must reconcile completion rather than invent another key. Only a verified acknowledgment confirms delivery.

Metadata includes collector/macOS/SEB versions, architecture, timezone, reported time and optional hostname/console-user evidence. Source includes username, UID, basename, home-relative path, source mtime and byte size. These are client-reported facts, separate from IT-assigned identity. No arbitrary command, executable, destination or source path can be supplied by a collection request.

Create an enrollment with `{ "label": "Device group or rollout", "ceiling": 1000, "days": 7 }`. The bootstrap authorizes a new Mac executing its scoped installer; deployment scope is controlled by the operator, with no serial roster or Jamf API lookup. Transactions enforce the ceiling, reject conflicting installations, and reconcile existing credentials without consuming another slot. The maximum window is seven days. PATCH can edit the name, ceiling and window, close enrollment, or reopen it with `{ "state": "open", "days": 7 }`; reopening preserves counts and device credentials.

POST `/api/admin/v1/enrollment-batches/:id/installer` returns the same readable install-and-enroll script on repeated authenticated downloads. Bootstrap codes are hashed for lookup and encrypted with AES-256-GCM under a domain-separated key derived from `SESSION_SECRET`, so the key must remain stable while these enrollments are used. List APIs exclude both the hash and ciphertext. A pre-0.2.0 batch stored only a hash: its first download rotates its code once, retaining the batch, count, and enrolled device credentials. Earlier copies of that batch’s script must then be replaced. Codes cannot grant dashboard or log access.

Admin APIs require a current Google-backed session, current Firestore permission and, for mutations, the exact Origin and `x-csrf-token` obtained from `/api/admin/v1/me`. Fleet, logs, collections, requests, batches and audits use cursor pagination ordered newest first by their relevant server timestamp, with document-ID tie breaking. Device filters use `deviceId`. Log opening verifies the immutable accepted generation, then streams plain text with inline disposition, no caching, MIME sniffing disabled and a sandbox CSP; download streams the accepted gzip generation. The older bounded preview API remains available. Access is rechecked at expiry even if deletion is pending.

| Admin operation           | Route                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Fleet/catalog             | GET `/api/admin/v1/devices`, `/logs`                                                           |
| Detail/preview/download   | GET `/devices/:id`, `/logs/:id`, `/logs/:id/open`, `/logs/:id/preview`, `/logs/:id/download`   |
| Request collection        | POST `/devices/:id/requests` with `from`, `to`                                                 |
| Pause/assignment          | PATCH `/devices/:id`                                                                           |
| Revoke                    | POST `/devices/:id/revoke`                                                                     |
| Cancel                    | DELETE `/collectionRequests/:id`                                                               |
| Batch creation/closure    | POST `/enrollment-batches`; PATCH `/enrollment-batches/:id`                                    |
| Repeat installer download | POST `/enrollment-batches/:id/installer` (CSRF required)                                       |
| Management scripts        | GET `/scripts/:action`, where action is `update`, `uninstall`, `collect`, `pause`, or `resume` |
| Live admins               | GET `/admins`; POST `/admins` with `email`, `active`                                           |
| Session association       | POST `/session-links` with `logId`, `instance`, `session`, optional `remove`                   |

Server-to-server Safe Online Exam lookup: GET `/api/integration/v1/logs?instance=<opaque>&session=<opaque>` with a separate integration bearer. Returns bounded unexpired metadata and admin deep links only. Safe Online Exam must enforce its own admin role; never place this credential in a browser. Manual links are labeled manual and do not infer identity from hostnames.

Maintenance POST `/api/internal/v1/maintenance` requires Google's OIDC signature, configured Scheduler identity and exact audience. Headers or knowledge of this path grant no access.

Firestore collections: devices, installations, enrollmentBatches, enrollmentTokens, collections, uploads, logs, dedup, collectionRequests, sessionLinks, quotaWindows, admins, settings, auditEvents. Log cleanup references have **no TTL**; they survive until the pinned object is deleted. Other expiry records use delayed TTL backstops. Device credential hashes persist until retired identity cleanup. Minimal revoked identifiers can remain to reject old credentials.
