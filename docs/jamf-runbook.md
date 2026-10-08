# Jamf School lifecycle

## Install and enroll

Enable the existing Jamf School scripting module. Copy the versioned embedded installer to an IT-controlled script and set `API_ORIGIN` to this deployment's HTTPS origin. Scope initially to a pilot group. The script installs fixed protected project files and the LaunchDaemon without downloading executable code. It preserves SEB, original logs, Keychain items, MDM profiles, and school certificates.

Create an enrollment batch in the dashboard using approved serials. Optional assignment columns are `assignedLabel`, `schoolEmail`, and `jamfId`. A batch has at most 400 serials to keep its creation atomic within Firestore's write limit; split larger fleets into multiple batches. Codes expire after seven days and are displayed once. Download the restricted enrollment script and scope it only to that roster group. Remove the enrollment script from scope and close the batch after successful rollout.

Installer/enrollment scope order is not guaranteed. Installation without credentials does not scan source logs. Deliver enrollment after installation is confirmed, and rerun idempotently if the first delivery arrives too early. A saved installation credential recovers a lost enrollment response even after the bootstrap expired.

The generic releases contain no bootstrap/device secrets or environment-specific origin. Jamf's restricted delivery does not conceal a secret from a local administrator. The permanent credential is different on each Mac; only its SHA-256 hash is stored on the server.

## Collect and pause

The daemon runs a bounded tick every 30 minutes and exits. Daily due times are staggered between 15:30 and 19:30 local time; later boots/ticks catch up. The initial window is seven days, subsequent discovery up to 90 days. Requests run at the next successful tick; use `collect-now.zsh` through Jamf for faster delivery. SEB running, a local pause, or a central pause defers work.

`status --json` reports nonsecret local state. The dashboard shows last contact, collection reports and quota/read problems. A sleeping/offline Mac is not instantly reachable. Central requests expire after 24 hours. Local pause/resume scripts work without network. The source helper uses the source user's UID/groups; it cannot use root's privileges to read private files.

Terminal reports remain in private state until delivery and request acknowledgment succeed, with a seven-day/100-report bound. Collector-owned logs rotate at 2 MiB with three archived files retained for at most seven days. Original SEB logs are never rotated or deleted by the collector.

## Update and recover

Regenerate versioned releases after changing source. Update uses the same checked embedded installer, stops the known job, checks the full staged payload, refuses incompatible database downgrades, and preserves credentials, the ledger, staging and pause state. The previous `bin` tree remains under the project-owned `previous` directory. Inspect the update result and daemon registration before declaring success.

For rollback, stop the job, verify the previous release checksum/version and SQLite schema compatibility, restore only the old `bin` directory, then register the current plist. Do not restore an older SQLite database or create a new enrollment to hide a failed update. An incomplete update requires operator recovery; it must not be declared successful because files were copied.

To replace credentials, revoke the old installation, explicitly reset the roster serial in its batch (API), and perform a targeted reinstall/re-enrollment. Stable server device IDs preserve accepted logs and deduplication. A revoked credential is never reactivated.

## Uninstall

Remove the device from installation and enrollment scopes first. Revoke it in the dashboard. Explicitly deploy `jamf/releases/uninstall.zsh`; removing installer scope alone does not remove already installed files.

The uninstaller works offline and idempotently, writes a stopping marker, attempts self-deactivation for a short bounded interval, boots out the fixed daemon, confirms known processes stopped, then removes only the fixed project paths. It never removes SEB, original user logs, MDM scripting/enrollment, or certificates. An offline removal is separate from server revocation and cancellation. Verify absence after reboot and launch an ordinary SEB exam.

## Pilot checks

Test the actual student homes and launchd/Jamf context. Do not grant fleet-wide Full Disk Access to a shared shell interpreter to work around a failed read. Investigate the responsible process and approved managed deployment instead. Custom log directories, privacy denials, multiple SEB installations and unsupported utility options require operator attention. The current collector intentionally supports the standard directory and fixed bounded limits; future device-specific overrides require explicit implementation/testing.
