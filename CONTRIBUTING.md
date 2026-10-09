# Contributing

Use Node 24 and `npm ci --ignore-scripts`. Keep configuration in ignored environment files and use synthetic identities/logs for development. Never attach enrollment scripts, device credentials, OAuth secrets or student log contents to public issues or pull requests.

Before submitting a change, run `npm test`, `npm run typecheck`, `npm run test:release` and `npm run build`. Collector changes also require the native macOS fixtures in [acceptance](docs/acceptance.md). Describe what was actually tested; fixtures and cloud probes do not replace managed-device acceptance.

Edit collector/Jamf source templates, not generated scripts. `npm run release:collector` generates ignored build output; [release maintenance](docs/releases.md) describes versions, checksums, tags and publication. Preserve old release tags/assets and compatibility with pending update commands. Production deployments and real device tests require the operator's authorization and explicit cloud account/project selection.
