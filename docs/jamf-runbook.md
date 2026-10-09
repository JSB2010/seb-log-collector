# Installation and device management

## Install and enroll

1. Open **Enrollment → Create enrollment**. Enter a rollout or group name, maximum device count (up to 1,000).
2. Select **Download script**. Paste the complete readable script into Jamf School with its scripting module enabled. Run as root, once per device, scoped initially to a restricted pilot.
3. Confirm the Macs appear in Fleet and report successful collection before expanding the scope. Close enrollment when rollout finishes.

Every Mac executing the script registers automatically with its own permanent credential. No serial list or Jamf API access is required. The name identifies an enrollment group; delivery scope and the current-member ceiling control enrollment. The same script can be used across the intended devices and downloaded again. Existing installations reconcile without consuming another slot. Groups remain open until you close them. **Reopen** restores availability, **Edit** changes the name or ceiling, and **Delete** removes an empty group from the current list. Deleted groups can be restored using the Deleted filter. Device details select membership from the group dropdown. **Manage Macs…** applies bulk pause, resume, revoke, collection, update or removal to the current members.

The complete installer source is in the script as readable quoted heredocs, with checksum and syntax validation before replacement. No base64-packed executable payload or installer-code download is used. The operational copy contains the configured origin and group bootstrap; keep it in restricted IT/Jamf storage. Generic public releases contain neither credentials nor a deployment origin.

An offline install records pending enrollment privately and starts the daemon to retry. Source scanning starts only after enrollment and fresh server permission. The bootstrap is removed after acknowledgment. Pending installation can retry while the group remains open. A lost enrollment response can reconcile with the saved permanent credential even after the group closes. An initially pending enrollment returns failure to Jamf, so inspect the eventual Fleet record before declaring success.

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

Starting with 1.0.0, the full install and update scripts also compare the installed version before replacing any files. If Jamf reruns a 1.0.0 script after the Mac has updated to 1.0.1, it keeps 1.0.1 and does not restart launchd, replace recovery files, or reset enrollment. A scoped enrollment script can still reconcile enrollment using the newer collector. Equal versions can repair the installation while preserving state. The binary version is a fallback if the version marker was truncated by an earlier wrong-shell run; an unknown existing version fails closed.

This protection is inside the **1.0.0 and later script**. Old 0.x scripts already stored in Jamf do not gain it automatically. Replace those operational copies once with a freshly downloaded 1.0.0 enrollment/update script. Keep that scoped script private. Execute manually with `sudo /bin/zsh -f "path/to/script.zsh"`; forcing `sh` or `bash` now stops immediately with a clear error.

**Reinstall.command** verifies the cached bootstrap-free installer and repairs the same version without network. Validation precedes stopping the daemon, and the previous binary directory is retained during replacement. State and credentials are preserved; a saved bootstrap is never needed for repairs or ordinary updates.

Uninstall is offline-safe and idempotent. It writes a stopping marker, attempts self-deactivation for a bounded interval, stops the fixed daemon and collector processes, and removes only project-owned paths. It leaves Safe Exam Browser, original user logs, MDM profiles, school certificates and unrelated software in place. If offline, revoke the device in Fleet separately. Confirm absence after reboot and launch an ordinary exam. To replace a revoked installation, uninstall and reinstall with an open enrollment; the stable server device ID preserves accepted logs and deduplication.

## Upgrading from before 0.2.0

Update existing Macs with the new dashboard Update script to add the local commands and organized folder layout. No re-enrollment is required. Downloading an older enrollment for the first time refreshes its code once because earlier releases stored only a hash. Replace earlier copies of that enrollment script; already enrolled Macs keep their credentials.

Server operators should add the descending Firestore indexes before switching traffic. If existing session associations are present, run `deployment/backfill-session-dates.mjs` with explicit `GCP_ACCOUNT` and `GCP_PROJECT`, inspect its dry-run counts, then run with `--apply` to copy each log’s acceptance timestamp without changing retention. Keep `SESSION_SECRET` stable: it also protects retrievable enrollment codes. After rotating it, create fresh enrollments rather than attempting to decrypt old codes.

## Pilot checks

Verify actual Jamf/launchd execution, standard and multiple users, relevant macOS versions and architectures, privacy access, SEB exam deferral, sleep/wake, offline retries, update preservation, and offline removal. Native fixtures and a successful cloud upload are separate evidence from a managed fleet pilot. Custom log directories and device-specific limit overrides require explicit implementation and testing.

## Remote update and removal without Jamf

Install 0.3.0 or newer once on existing Macs (use their **Update.command** or the dashboard’s generic Jamf Update script). After that, **Fleet → device → Queue update / Queue uninstall** and **Enrollment → Manage Macs…** deliver typed commands at the next check-in. Pausing collection does not stop management check-in. Safe Exam Browser activity defers lifecycle changes. Requests → Updates and uninstall shows device results; Requests → Group actions shows bulk outcomes. Offline Macs remain queued, and completion is shown only after a Mac reports success.

Update downloads the exact server-approved HTTPS release, checks SHA-256 and shell syntax, refuses downgrades and preserves credentials/configuration/pause/ledger/staging. A separate transient launchd worker survives replacement of the collector’s own job. It removes its private temporary credentials after bounded execution. Reinstall is offline repair of the current version. The installed collector does not silently auto-update unless IT queues an update.

Remote uninstall revokes access when the Mac claims the command, then removes only the collector’s fixed project paths. It reports success after verifying removal. If the network fails after removal, the server may show completion unconfirmed: it cannot contact a removed daemon. Failed removal may require local repair/removal and re-enrollment because the credential is already revoked. No uninstall is performed on a real pilot Mac merely to validate a release; use a disposable test installation.

## Server upgrade to 0.3.0

Apply the new Firestore indexes and remove enrollment-group/token TTL policies before switching traffic. Run `GCP_ACCOUNT=your-account GCP_PROJECT=your-project node deployment/migrate-030.mjs`, review the dry-run counts, then repeat with `--apply`. The preconditioned atomic migration sets current group membership/counts, clears old enrollment expiry/TTL and backfills session dates without extending log retention. It refuses more than 450 changed documents; larger existing fleets need a staged migration during a maintenance window. Keep old received-date indexes for rollback. Versioned update artifacts must remain available for the seven-day lifetime of queued commands, even after publishing a newer release.
