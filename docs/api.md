# API and data contract

All API requests use HTTPS. JSON bodies are limited to 256 KiB and validated against strict typed schemas. Timestamps are UTC RFC 3339. Errors use `{"error":{"code":"...","requestId":"..."}}`. Device API version is one. Source bytes belong in GCS, never Firestore or application logs.

Device authentication: `Authorization: Bearer <installationUUID>.<base64url32ByteSecret>`. Enrollment instead supplies a group bootstrap bearer and a body with `schemaVersion`, `installationId`, `serial`, `credentialHash`, and `metadata`. Hash the decoded 32 raw secret bytes, not its base64 text.

| Route                                      | Purpose                                                      |
| ------------------------------------------ | ------------------------------------------------------------ |
| POST `/api/device/v1/enroll`               | Transactional automatic enrollment                           |
| GET `/api/device/v1/config`                | Pause state, limits, collection requests and device commands |
| POST `/api/device/v1/collections`          | Idempotent collection UUID / summary                         |
| POST `/api/device/v1/uploads/prepare`      | Deduplicate or reserve one immutable signed POST             |
| GET `/api/device/v1/uploads/:id`           | Own reservation / acknowledgment status                      |
| POST `/api/device/v1/uploads/:id/complete` | Verify actual bytes and durably acknowledge                  |
| POST `/api/device/v1/requests/:id/ack`     | Received, deferred, running, completed, failed               |
| POST `/api/device/v1/deactivate`           | Revoke own installation and cancel requests                  |

Prepare supplies `schemaVersion`, `collectionId`, optional `requestId`, raw/gzip SHA-256 and exact byte sizes, `source`, and `metadata`. The server chooses a PII-free key, reserves device/global daily volume once, and signs an exact bucket/key/type/length POST policy for ten minutes. Submit all returned literal fields, then `file` last. A failed overwrite POST must reconcile completion rather than invent another key. Only a verified acknowledgment confirms delivery.

Metadata includes collector/macOS/SEB versions, architecture, timezone, reported time and optional hostname/console-user evidence. Source includes username, UID, basename, home-relative path, source mtime and byte size. These are client-reported facts, separate from IT-assigned identity. No arbitrary command, executable, destination or source path can be supplied by a collection request.

Create an enrollment with `{ "label": "Device group or rollout", "ceiling": 1000 }`. The bootstrap authorizes a new Mac executing its scoped installer; deployment scope is controlled by the operator, with no serial roster or Jamf API lookup. Transactions enforce the ceiling, reject conflicting installations, and reconcile existing credentials without consuming another slot. Groups have no expiry or TTL. PATCH edits the name/ceiling, closes or reopens (`{ "state": "open" }`) a group, or deletes an empty group (`{ "state": "deleted" }`). Deletion is recoverable by reopening. Counts represent current registered members; moving or revoking a Mac adjusts the counts atomically. `enrollmentBatchId` preserves original provenance; `enrollmentGroupId` is current membership.

POST `/api/admin/v1/enrollment-batches/:id/installer` returns the same readable install-and-enroll script on repeated authenticated downloads. Bootstrap codes are hashed for lookup and encrypted with AES-256-GCM under a domain-separated key derived from `SESSION_SECRET`, so the key must remain stable while these enrollments are used. List APIs exclude both the hash and ciphertext. A pre-0.2.0 batch stored only a hash: its first download rotates its code once, retaining the batch, count, and enrolled device credentials. Earlier copies of that batch’s script must then be replaced. Codes cannot grant dashboard or log access.

Admin APIs require a current Google-backed session, current Firestore permission and, for mutations, the exact Origin and `x-csrf-token` obtained from `/api/admin/v1/me`. Fleet, logs, collections, requests, batches and audits use cursor pagination ordered newest first by their relevant server timestamp, with document-ID tie breaking. Device filters use `deviceId`. Log opening verifies the immutable accepted generation, then streams plain text with inline disposition, no caching, MIME sniffing disabled and a sandbox CSP; download streams the accepted gzip generation. The older bounded preview API remains available. Access is rechecked at expiry even if deletion is pending.

| Admin operation           | Route                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Fleet/catalog             | GET `/api/admin/v1/devices`, `/logs`                                                           |
| Detail/preview/download   | GET `/devices/:id`, `/logs/:id`, `/logs/:id/open`, `/logs/:id/preview`, `/logs/:id/download`   |
| Request collection        | POST `/devices/:id/requests` with `from`, `to`                                                 |
| Pause/group membership    | PATCH `/devices/:id`                                                                           |
| Revoke                    | POST `/devices/:id/revoke`                                                                     |
| Cancel                    | DELETE `/collectionRequests/:id`                                                               |
| Batch creation/closure    | POST `/enrollment-batches`; PATCH `/enrollment-batches/:id`                                    |
| Repeat installer download | POST `/enrollment-batches/:id/installer` (CSRF required)                                       |
| Management scripts        | GET `/scripts/:action`, where action is `update`, `uninstall`, `collect`, `pause`, or `resume` |
| Live admins               | GET `/admins`; POST `/admins` with `email`, `active`                                           |
| Session association       | POST `/session-links` with `logId`, `instance`, `session`, optional `remove`                   |

Server-to-server Safe Online Exam lookup: GET `/api/integration/v1/logs?instance=<opaque>&session=<opaque>` with a separate integration bearer. Returns bounded unexpired metadata and admin deep links only. Safe Online Exam must enforce its own admin role; never place this credential in a browser. Manual links are labeled manual and do not infer identity from hostnames.

Maintenance POST `/api/internal/v1/maintenance` requires Google's OIDC signature, configured Scheduler identity and exact audience. Headers or knowledge of this path grant no access.

Firestore collections: devices, installations, enrollmentBatches, enrollmentTokens, collections, uploads, logs, dedup, collectionRequests, deviceCommands, groupOperations, sessionLinks, quotaWindows, admins, settings, auditEvents. Log cleanup references have **no TTL**; they survive until the pinned object is deleted. Other expiry records use delayed TTL backstops. Device credential hashes persist until retired identity cleanup. Minimal revoked identifiers can remain to reject old credentials.

## Remote lifecycle and group operations

Version 0.3.0 collectors advertise `metadata.managementProtocol: 1` and `X-Collector-Management: 1`. Existing Macs need one initial upgrade via their Update command or the dashboard’s Jamf update script. This capability gates admin remote actions. Device commands are limited to `update` and `uninstall`; no arbitrary command or URL is accepted.

POST `/devices/:id/commands` with `{ "action": "update" }` or `{ "action": "uninstall" }` queues one command per installation. Updates pin the deployed release version, immutable `/collector/releases/:version/install.zsh` path and SHA-256. The collector checks in every 30 minutes while awake, including when local/central collection is paused. An active SEB exam defers lifecycle execution.

POST `/api/device/v1/commands/:id/ack` accepts deferred/running/completed/failed results. Uninstall revokes the installation at the running claim; a narrow grant permits only that installation’s matching teardown-result acknowledgment until its deadline. Normal data APIs remain denied. Completion requires `removed`, or `installed` with the exact target version. Expired running commands display completion unconfirmed. Pending commands can be cancelled with DELETE `/deviceCommands/:id`; running commands cannot. Device commands have a seven-day execution deadline and 90-day history retention.

GET `/enrollment-groups` provides all available groups for membership selection. PATCH `/devices/:id` accepts `enrollmentGroupId`, state and school email. POST `/enrollment-batches/:id/actions` accepts `action` (pause/resume/revoke/collect/update/uninstall) and UUID `operationId`. It snapshots current registered membership and revalidates membership before each action. Stable child IDs make retries idempotent. GET `/groupOperations` reports individual results, including skipped unsupported collectors. Repeating the same operation resumes unfinished work; changing membership does not retroactively extend its scope.

The log catalog defaults to `sort=session-newest`; other sorts are session-oldest/received-newest/received-oldest. Date bounds follow the selected basis. Session timestamps come from SEB filenames in the reporting Mac timezone, falling back to source mtime for invalid, unknown, or ambiguous times. Current device names are resolved from Fleet. Session-link records carry both timestamps for matching sorts. Cursor ties use document IDs in the same direction.

API-only `collector` and `sourceUser` filters apply to ordered catalog pages without creating every possible prefix-index combination. Such pages may contain fewer than 50 results; follow `nextCursor` until null. The dashboard’s search, device, macOS and SEB filters use indexed queries for all four sort orders.
