# Changelog

## 1.0.0

First stable release of Safe Online Exam Logs.

- Publish readable install, update, uninstall, collect, pause and resume scripts as GitHub release assets with a manifest and SHA-256 checksums. Generated artifacts no longer live in the source tree.
- Run server and native macOS checks before publishing a versioned release. Match the tag, source version and generated manifest; refuse to overwrite an already published release.
- Keep a newer installed version when an older 1.0 installer or updater is rerun. Preserve enrollment, local pause, ledger and queued logs; recover a truncated version marker from the binary version.
- Reject incorrect `sh`/`bash` execution before changing files. Use explicit zsh for manual and managed execution.
- Retain exact historical update installers through checksum-pinned build downloads so existing queued commands remain usable.
- Include fleet app versions, dedicated enrollment action dialogs, readable activity, compact log timestamps and responsive detail panels from the preview builds.

Existing devices can update without re-enrollment. Replace pre-1.0 Jamf script copies with a fresh dashboard download to gain stale-installer protection. Generic release assets have no school configuration or enrollment credentials.

Native fixtures mock transport and launchd. Full Jamf, macOS architecture/version, privacy-access and exam-deferral pilot checks remain required before expanding a school deployment. See `docs/acceptance.md`.

## 0.x previews

Earlier releases are retained as previews, including their original tags and assets. Version 0.3.0 is archived with its original artifact bytes for pending updates. The first stable release is 1.0.0.
