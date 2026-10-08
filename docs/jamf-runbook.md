# Installation and device management

## Install and enroll

1. Open **Enrollment → Create enrollment**. Enter a rollout or group name, maximum device count (up to 1,000), and a one-, three-, or seven-day window.
2. Select **Download script**. Paste the complete readable script into Jamf School with its scripting module enabled. Run as root, once per device, scoped initially to a restricted pilot.
3. Confirm the Macs appear in Fleet and report successful collection before expanding the scope. Close enrollment when rollout finishes.

Every Mac executing the script registers automatically with its own permanent credential. No serial list or Jamf API access is required. The name is an assignment label; delivery scope, the time window, and the registration ceiling control enrollment. The same script can be used across the intended devices and downloaded again. Existing installations reconcile without consuming another slot. **Reopen** extends the same enrollment for seven days; **Edit** changes its name, ceiling, or window without resetting its enrolled count.

The complete installer source is in the script as readable quoted heredocs, with checksum and syntax validation before replacement. No base64-packed executable payload or installer-code download is used. The operational copy contains the configured origin and temporary bootstrap; keep it in restricted IT/Jamf storage. Generic public releases contain neither credentials nor a deployment origin.

An offline install records pending enrollment privately and starts the daemon to retry. Source scanning starts only after enrollment and fresh server permission. The bootstrap is removed after acknowledgment or seven days locally; the server’s shorter window still applies. A lost enrollment response can reconcile with the saved permanent credential after bootstrap expiry. An initially pending enrollment returns failure to Jamf, so inspect the eventual Fleet record before declaring success.

## Local commands

The installer places these at `/Library/Application Support/SOEDiagnostics/`:

| Double-click command               | Behavior                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- |
| **Collect Now.command**            | Run a bounded collection immediately, then show status                 |
| **Status.command**                 | Show version, enrollment, local pause, outcome and last contact        |
| **Update.command**                 | Fetch and install a newer verified release from the configured service |
| **Reinstall.command**              | Repair the current cached release offline                              |
| **Uninstall.command**              | Remove the collector and attempt server revocation                     |
| **Pause.command / Resume.command** | Control local collection                                               |

Double-clicking opens Terminal automatically and requests administrator authentication through `sudo`. Touch ID is available only if the Mac already enables it for sudo; the installer does not change authentication settings. `Read Me.txt` explains the commands. Internal code is in `bin/`, recovery and maintenance scripts in root-only `support/`, and private runtime data in `credentials/`, `state/`, and `staging/`. No PATH command is installed.

## Collection and dashboard requests

The LaunchDaemon checks in every 30 minutes while awake, runs a bounded tick, and exits. Daily collections are staggered between 15:30 and 19:30 local time with catch-up after later boots. The initial scan window is seven days; later scans can discover up to 90 days of logs.

**Queue collection** creates a server-side request. At its next successful check-in, the Mac reads the request, acknowledges it, and performs the specified bounded collection. It is a working polling mechanism, not an immediate connection to the Mac. Requests expire after 24 hours. Sleeping/offline Macs wait until they can check in. Safe Exam Browser running, local pause, or central pause defers scanning. For faster delivery use **Collect now** through Jamf or the local command.

Device details show human-readable collection history and link to that device’s logs. The catalog’s **Open** action opens authenticated, verified plain text in a new tab; **Download gzip** remains available in log details. Dates, device filters, tabs, and selected details survive refresh through real page URLs.

Collection failures can occur before upload. `ledger_error` is a failed SQLite operation, not necessarily a transport failure. Inspect nonsecret `status --json`, the ledger summary, and collector logs. The source helper runs with the source user’s UID/groups; it does not use root to read private source files. Do not grant fleet-wide Full Disk Access to a shared shell interpreter as a workaround.

## Remote update, collection, pause, and removal

In **Enrollment → Device management**, download or copy the **Update**, **Uninstall**, **Collect now**, **Pause**, or **Resume** script. Paste the complete script into Jamf School, run as root once, and use an explicit device/group scope. These use existing credentials and need no enrollment token. A script runs on every Mac in its Jamf scope; select the entire managed scope only when that is the intended action.

The dashboard’s Update script is the currently deployed release’s complete updater. Download a fresh copy after a release and test it on a restricted scope before widening. It safely exits if the collector is absent and preserves origin, credentials, ledger, queued payloads, and local pause. The local **Update.command** instead consults the configured service’s approved `collector/manifest.json`, validates the version and fixed same-origin installer path, uses HTTPS without insecure TLS or redirect following, verifies SHA-256 and syntax, and refuses downgrades. GitHub releases contain the matching generic package and checksums; updating follows the deployed approved release rather than blindly trusting the newest GitHub tag.

**Reinstall.command** verifies the cached bootstrap-free installer and repairs the same version without network. Validation precedes stopping the daemon, and the previous binary directory is retained during replacement. State and credentials are preserved; a saved bootstrap is never needed for repairs or ordinary updates.

Uninstall is offline-safe and idempotent. It writes a stopping marker, attempts self-deactivation for a bounded interval, stops the fixed daemon and collector processes, and removes only project-owned paths. It leaves Safe Exam Browser, original user logs, MDM profiles, school certificates and unrelated software in place. If offline, revoke the device in Fleet separately. Confirm absence after reboot and launch an ordinary exam. To replace a revoked installation, uninstall and reinstall with an open enrollment; the stable server device ID preserves accepted logs and deduplication.

## Upgrading from before 0.2.0

Update existing Macs with the new dashboard Update script to add the local commands and organized folder layout. No re-enrollment is required. Downloading an older enrollment for the first time refreshes its code once because earlier releases stored only a hash. Replace earlier copies of that enrollment script; already enrolled Macs keep their credentials.

Server operators should add the descending Firestore indexes before switching traffic. If existing session associations are present, run `deployment/backfill-session-dates.mjs` with explicit `GCP_ACCOUNT` and `GCP_PROJECT`, inspect its dry-run counts, then run with `--apply` to copy each log’s acceptance timestamp without changing retention. Keep `SESSION_SECRET` stable: it also protects retrievable enrollment codes. After rotating it, create fresh enrollments rather than attempting to decrypt old codes.

## Pilot checks

Verify actual Jamf/launchd execution, standard and multiple users, relevant macOS versions and architectures, privacy access, SEB exam deferral, sleep/wake, offline retries, update preservation, and offline removal. Native fixtures and a successful cloud upload are separate evidence from a managed fleet pilot. Custom log directories and device-specific limit overrides require explicit implementation and testing.
