# Release maintenance

The current repository contains source templates and tooling. Generated scripts live in GitHub release assets and ignored local build output, never in commits. Deployment-specific enrollment downloads contain private bootstrap credentials and must never be uploaded to a public release.

## Names and assets

Use canonical semantic versions: `1.0.0`, `1.0.1`, `1.1.0`, `2.0.0`. Git tags are `v<version>`; stable titles are **Safe Online Exam Logs <version>**. All 0.x releases remain labeled **(preview)** and are not Latest. Do not delete them or rewrite their tags. GitHub's Latest release is the newest intentionally published stable release.

Each stable release has six `safe-online-exam-logs-<version>-<action>.zsh` assets (`install`, `update`, `uninstall`, `collect-now`, `pause`, `resume`), `manifest.json`, and `SHA256SUMS`. GitHub also supplies source archives. The install/update files contain readable source, checksums, preflight checks and recovery commands. They use no packed executable payload.

`npm run release:collector` creates `dist/collector/<version>/` and `public/collector/`. The same source and version produce the same bytes across macOS and Linux. `npm run verify:release` verifies every file and the runtime installer. `RELEASE_TAG=v1.0.0 npm run verify:release` also validates the tag. `npm run test:release` verifies deterministic output and that generated directories have no tracked files.

## Publish a stable release

1. Update `package.json`, the root and root-package versions in `package-lock.json`, and `collector/soe-diagnostics`'s `VERSION`. Add a matching entry to `CHANGELOG.md`. The generator rejects a version mismatch or noncanonical version.
2. Before deploying the next version, add the previous stable installer asset name/version/hash to `deployment/collector-history.json`. Its hash comes from the verified previous release. Keep each pin for at least seven days after the successor is deployed; longer retention is inexpensive. Mirror assets byte-for-byte if changing `COLLECTOR_RELEASE_REPOSITORY`.
3. Run server tests/typecheck/build/audit, `npm run test:release`, and all native macOS fixtures in `docs/acceptance.md`. Inspect the resulting diff; only source, metadata, documentation and workflow changes should be committed.
4. Commit and push the release source. Wait for **Checks** to pass. Create a signed annotated `v<version>` tag at that exact commit and push it.
5. **Release** reruns the server/macOS checks, transfers the verified assets, checks checksums/tag/version, creates or resumes a draft, uploads its assets and publishes it as stable/Latest. Only its publication job has repository write permission. An already published release cannot be overwritten by rerunning the workflow; publish a new patch instead. A failed draft can be resumed after fixing the external failure, without moving a published tag.
6. Download the GitHub assets and compare their checksums with the locally generated files. Build the production container from the tagged source, deploy its immutable digest, and verify health, authentication, manifest/checksum and preserved historical installer routes. Reconcile Terraform and retain the rollback digest.
7. Test one authorized enrolled Mac's upgrade and enrollment preservation before widening rollout. Replace old 0.x Jamf script copies with the new scoped script from the dashboard.

Publication and production promotion are separate. GitHub Actions does not carry cloud credentials or automatically update devices. Local **Update.command** and dashboard remote updates follow the release deployed to the Mac's configured service, not an arbitrary newest GitHub tag. Deploying the server does not update every Mac; administrators explicitly queue or deliver updates.

## Rerunning a Jamf installer

A 1.0.0 script sees an installed 1.0.1 and keeps it. It does not downgrade, restart its daemon, replace its recovery cache or reset credentials/queued data. A scoped script can reconcile enrollment using the installed newer collector. A same-version script can repair the installation; a newer script upgrades it. The installer reads both the state marker and embedded binary version, chooses the higher valid version, and fails closed if an existing binary has no recognizable version.

This behavior cannot change a script already copied into Jamf before 1.0. Replace the old script once. Run zsh scripts with their shebang or `sudo /bin/zsh -f "script.zsh"`; do not override the interpreter with `sh`.

Stable release status does not replace the operator's managed-device acceptance matrix. Keep untested platform/privacy/Jamf cases explicitly pending.
