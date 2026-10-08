# Safe Online Exam Logs

Collect Safe Exam Browser application logs from managed Macs for school IT. A small native-tool zsh collector is delivered through Jamf School; a Next.js dashboard catalogs verified gzip snapshots in private Google Cloud Storage and Firestore.

This project requires no Apple Developer account, signed package, notarization, student-side Node/Python, Canvas token, or changes to SEB settings. Local administrators can inspect or stop the collector and change their own logs. Diagnostics cannot prove client authenticity or completeness.

## Components

- `src/server`: enrollment, per-device credentials, durable reservations/quotas, verification, admin authorization, retention, and optional Safe Online Exam lookup.
- `src/components`: fleet, log catalog, device details, roster enrollment, requests, audit history, and live administrator management.
- `collector`: short-lived zsh coordinator, SQLite ledger, and source reader running as the source user.
- `jamf/releases`: embedded install/update scripts, offline uninstaller, manifest, and SHA-256 checksums.
- `infra`: Terraform for private storage, Firestore/indexes/TTL, narrow identities, Cloud Run, secrets, Scheduler, and monitoring.
- `docs`: operating instructions, security limitations, API contracts, and acceptance gates.

## Local development

Use Node 24 LTS and the pinned lockfile. Copy `.env.example` to `.env.local`, supply configuration, and run:

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
npm run dev
```

For an isolated synthetic dashboard, set `DEV_AUTH=true` and `DEV_MEMORY=true`, use `http://127.0.0.1:3000` as `PUBLIC_ORIGIN`, and fill the remaining settings with synthetic values. The local UI supplies `x-dev-admin: true` only when compiled in development and opened on loopback. Every bypass is rejected in production and Cloud Run. Then run `node tests/local-api-smoke.mjs` once against the empty local store. Do not use real school data in memory mode.

On a development Mac, run `node tests/macos-executables.mjs`, `node tests/macos-installer.mjs`, and `/bin/zsh -f tests/macos-tools.zsh`. These verify shipped command paths, generated payload extraction/recovery, and native utilities against workspace fixtures; launchd/process controls are mocked and no real SEB logs are accessed. `npm run release:collector` regenerates the Jamf payloads. CI runs server checks, native macOS checks, and pinned ShellCheck on the portable deployment wrapper. ShellCheck does not understand zsh; zsh sources use the actual zsh parser and macOS behavior tests.

## Deployment

Follow [cloud setup](docs/cloud-setup.md). Configuration and credentials belong in ignored env/tfvars files and Secret Manager. Do not commit operational rosters, bootstrap codes, downloaded logs, service-account keys, Terraform state, or OAuth secrets. Use attached service identities and IAM signing rather than downloaded private keys.

Create infrastructure first with `create_service=false`, add the session secret version, build the container, and deploy with `create_service=true` and an immutable image digest. Set a deliberately small maximum instance count; zero minimum instances avoids idle compute. Billing alerts are alerts, not spending caps. Measured pilot volume should determine an operating budget.

Google OAuth configuration is required for human sign-in. Admins are explicitly allowlisted; domain membership alone grants no access. `SEED_ADMIN_EMAILS` initializes Firestore once. After initial admission, the **Admins** screen changes access live, audits changes, and prevents removal of the last administrator. Existing sessions check the current list on every API call.

## Jamf and rollout

Follow [installation and removal](docs/jamf-runbook.md). Create a Jamf-group enrollment batch in the dashboard and download its combined install-and-enroll script. Macs running that scoped script register automatically, without a serial list, using a temporary bootstrap and unique permanent credentials. Serial-roster enrollment remains optional. Public generic packages contain no deployment origin or bootstrap; the downloaded operational script must stay restricted. Version one supports the standard home-relative SEB log directory and leaves privacy settings unchanged.

Complete a five-to-ten-device pilot before fleet rollout. Verify the actual launchd/Jamf context, SEB exam deferral, privacy access, sleep/wake, standard and admin users, Intel/Apple silicon where needed, updates, and offline removal. See [acceptance checklist](docs/acceptance.md). A successful cloud upload or shell syntax check is separate evidence from successful managed-device deployment.

## Data and access

Device credentials authorize only that device's control and upload API. The create-only signer cannot read, delete, or overwrite objects. The backend pins generations, checks both SHA-256 hashes and byte counts, validates a single gzip member, and rejects extra payloads and excessive expansion.

Accepted logs expire 90 days after GCS first created the verified generation. The application denies access immediately at expiry; bounded hourly maintenance and bucket lifecycle rules delete bytes asynchronously. Soft delete and versioning are disabled. Log metadata, reports, associations, and audits expire after at most 90 days. Active fleet enrollment and admin configuration remain while managed; retired device metadata expires after 90 days, with a minimal revoked installation identifier/hash retained to reject old credentials. Duplicate submissions and session associations never restart retention. Original SEB logs and separately downloaded admin copies are outside cloud cleanup.

Safe Online Exam integration is optional and server-to-server. It provides manual opaque session associations and a separate read-only lookup credential; Safe Online Exam must authenticate and authorize its own admins. There is no assumed existing Safe Online Exam API.

## License

MIT. See [LICENSE](LICENSE).
