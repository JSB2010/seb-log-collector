# Jamf School lifecycle

## Install and enroll

Enable the existing Jamf School scripting module. In the dashboard, create an enrollment batch using **Jamf group — automatic acceptance**, enter the group name and a device ceiling, then download the **install and enroll** script. Scope it to that Jamf group, initially a restricted pilot. Every Mac running the script automatically registers with its own credential; no serial list is required. The group name is an assignment label, not a live Jamf API membership check. Possession of the short-lived bootstrap delivered in the scoped script permits registration within the window and ceiling.

The downloaded script embeds the checked collector payload and deployment origin, installs fixed protected project files, enrolls, then registers the LaunchDaemon. It downloads no executable code and preserves SEB, original logs, Keychain items, MDM profiles, and school certificates. Bootstrap codes expire after at most seven days and are shown once. Automatic batches admit at most 1,000 registrations. Close the batch and remove the script from scope after rollout; later devices use a fresh batch. Do not publish the downloaded operational script.

An offline install records pending enrollment privately and starts the daemon for retry. No source scan occurs until enrollment succeeds and fresh collection permission is received. The bootstrap is removed on acknowledgment or after seven days locally; the server's shorter expiry still applies. A saved installation credential recovers a lost enrollment response even after bootstrap expiry. Jamf receives failure for a pending initial enrollment, so confirm the eventual fleet record before declaring installation complete.

**Approved serial roster** remains an optional stricter mode. CSV columns are `serial`, optionally `assignedLabel`, `schoolEmail`, and `jamfId`; use at most 400 per atomic batch. Generic install/update scripts remain available for lifecycle operations and contain no bootstrap. The dashboard's combined installer prevents separate installation/enrollment scope ordering problems.

The generic releases contain no bootstrap/device secrets or environment-specific origin. Jamf's restricted delivery does not conceal a secret from a local administrator. The permanent credential is different on each Mac; only its SHA-256 hash is stored on the server.

## Collect and pause

The daemon runs a bounded tick every 30 minutes and exits. Daily due times are staggered between 15:30 and 19:30 local time; later boots/ticks catch up. The initial window is seven days, subsequent discovery up to 90 days. Requests run at the next successful tick; use `collect-now.zsh` through Jamf for faster delivery. SEB running, a local pause, or a central pause defers work.

`status --json` reports nonsecret local state. The dashboard shows last contact, collection reports and quota/read problems. A sleeping/offline Mac is not instantly reachable. Central requests expire after 24 hours. Local pause/resume scripts work without network. The source helper uses the source user's UID/groups; it cannot use root's privileges to read private files.

A collection failure can occur before upload. A local `lastError` of `ledger_error` identifies a failed SQLite operation; collector errors omit source/device metadata. Diagnose the local status and ledger before treating every failed collection as a network outage.

Terminal reports remain in private state until delivery and request acknowledgment succeed, with a seven-day/100-report bound. Collector-owned logs rotate at 2 MiB with three archived files retained for at most seven days. Original SEB logs are never rotated or deleted by the collector.

## Update and recover

Regenerate versioned releases after changing source. Update uses the same checked embedded installer, stops the known job, checks the full staged payload, refuses incompatible database downgrades, and preserves credentials, the ledger, staging and pause state. The previous `bin` tree remains under the project-owned `previous` directory. Inspect the update result and daemon registration before declaring success.

Version 0.1.2 corrects native `chown` and `readlink` paths and checks required tools before stopping a job. For the 0.1.1 installer failure reporting `/bin/chown`, replace the Jamf script with a newly downloaded install-and-enroll script and run it again on the same restricted scope. Reuse the original operational bootstrap only while its batch remains open and unexpired; otherwise create a fresh batch. The installer repairs the partial files while preserving existing configuration and device credentials. Verify a successful Jamf result, collector version, and a Fleet record before expanding scope.

Version 0.1.3 corrects SQLite quoting for apostrophes in computer names, filenames and other metadata, and hashing of filenames containing backslashes. It recovers compressed files left without a ledger row by rebuilding them from the verified original source during discovery. Update existing installations with the generic updater, then run `collect-now.zsh` in the same restricted scope to trigger discovery immediately. Confirm accepted logs, a successful collection report and no local staged backlog. Keep the original enrollment and ledger; re-enrollment does not repair this failure. A failed ledger confirmation or expiry update preserves its staged payload. Untracked payloads expire after seven days and incomplete compression after one day; original SEB logs remain untouched.

For rollback, stop the job, verify the previous release checksum/version and SQLite schema compatibility, restore only the old `bin` directory, then register the current plist. Do not restore an older SQLite database or create a new enrollment to hide a failed update. An incomplete update requires operator recovery; it must not be declared successful because files were copied.

To replace credentials, revoke the old installation and remove its local credential through a targeted uninstall/reinstall using a fresh automatic batch. If using roster mode, explicitly reset the serial in its batch (API) before re-enrollment. Stable server device IDs preserve accepted logs and deduplication. A revoked credential is never reactivated.

## Uninstall

Remove the device from installation and enrollment scopes first. Revoke it in the dashboard. Explicitly deploy `jamf/releases/uninstall.zsh`; removing installer scope alone does not remove already installed files.

The uninstaller works offline and idempotently, writes a stopping marker, attempts self-deactivation for a short bounded interval, boots out the fixed daemon, confirms known processes stopped, then removes only the fixed project paths. It never removes SEB, original user logs, MDM scripting/enrollment, or certificates. An offline removal is separate from server revocation and cancellation. Verify absence after reboot and launch an ordinary SEB exam.

## Pilot checks

Test the actual student homes and launchd/Jamf context. Do not grant fleet-wide Full Disk Access to a shared shell interpreter to work around a failed read. Investigate the responsible process and approved managed deployment instead. Custom log directories, privacy denials, multiple SEB installations and unsupported utility options require operator attention. The current collector intentionally supports the standard directory and fixed bounded limits; future device-specific overrides require explicit implementation/testing.
