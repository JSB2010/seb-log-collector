# Cloud setup

1. Use a dedicated GCP project with billing. Choose a regional location before creating Firestore. Run `deployment/enable-apis.sh` with `GCP_ACCOUNT` and `GCP_PROJECT` to enable the required APIs. Use explicit `--account="$GCP_ACCOUNT" --project="$GCP_PROJECT"` on every cloud command; do not switch the globally active account or overwrite ADC. Terraform uses the deployment project as its API quota project.
2. Copy `infra/deployment.example.tfvars` to an ignored operational file. Initialize and apply Terraform with a command-scoped `GOOGLE_OAUTH_ACCESS_TOKEN` obtained from the explicitly selected account. Protect Terraform state and move it to a restricted backend for shared operations.
3. Populate `diagnostics-session` with at least 32 cryptographically random bytes. The Terraform state contains secret references, not secret versions. Supply values through private files/stdin; never command-line literal secrets.
4. Build via `deployment/cloudbuild.yaml`, using `_IMAGE` for the target registry. Configure a separate build identity or an existing authorized build identity. Supply only source covered by `.gcloudignore`. Deploy the resulting digest, never an ambiguous mutable tag. The container runs as a non-root user with Node 24 LTS.
5. Set `PUBLIC_ORIGIN` to the service's HTTPS origin without a trailing slash, and the same origin as `SCHEDULER_AUDIENCE`. Enable the service with one CPU, 1 GiB, concurrency eight, zero minimum instances and at most five instances. Cloud Run ingress is publicly reachable; application routes enforce all data access.

## Google sign-in setup

In **Google Auth Platform**, select this project. Configure branding with an application name and operator support contact. Select **Internal** audience when the project belongs to the school's Workspace organization. Otherwise use an external testing audience and explicit test users until the operator completes production consent requirements. Request only `openid`, `email`, and `profile`.

Create a **Web application** client. Authorized JavaScript origin: the exact `PUBLIC_ORIGIN`. Authorized redirect URI: `PUBLIC_ORIGIN/api/auth/callback`. Save the client secret directly into Secret Manager's `diagnostics-oauth-client-secret` secret, set `oauth_client_id`, enable `oauth_secret_enabled`, and redeploy the configuration. Do not paste the secret into source, shell history, browser-visible environment variables, or chat.

The application validates Google's signature, issuer, client audience, expiration, email verification, hosted domain and OAuth nonce. It also uses PKCE and a signed, short-lived state cookie. Only seeded/current Firestore admins can sign in. A student with a valid school-domain account must be denied. Test actual browser sign-in, sign-out, forged/expired tokens, wrong audience/domain and a nonadmin school user before rollout.

The new client cannot be created with a normal `gcloud auth login` command. A signed-in Google Auth Platform operator must complete the client configuration. Until client values are configured, sign-in fails closed with `oauth_not_configured`; device authentication remains independent.

## Storage and maintenance

The runtime has catalog access, log object get/delete permission, required secret access, and `signBlob` on the separate create-only signer. It has no log object create permission. The signer has bucket-scoped `storage.objectCreator` only. Bucket public access prevention and uniform access are enforced, with no ACL fields in POST policies.

Scheduler sends an OIDC token with the configured service account and exact audience. The application independently verifies it because the service permits unauthenticated ingress. Trigger the actual Scheduler job and inspect a sanitized `maintenance` event to validate forwarded-token behavior. A mere successful job creation is insufficient. If a platform strips token signatures, use a second IAM-protected maintenance service with the same image; do not weaken validation.

Configure `notification_email` or existing verified channel IDs and a project-specific billing budget. Terraform connects the recipient to server-error, overdue-cleanup, and budget notifications; complete any email verification Google requires. Threshold alerts occur at 50/80/100 percent when a billing account is configured. Billing account privileges may be separate from project ownership. Alerts do not cap costs. Keep Cloud Run maximum instances and issuance quotas bounded; measure storage and read/write growth during the pilot.

For Safe Online Exam lookup, populate `diagnostics-integration`, enable `integration_secret_enabled`, and keep the credential in Safe Online Exam's server secret store. The contract is in [API](api.md).
