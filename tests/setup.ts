Object.assign(process.env, {
  GOOGLE_CLOUD_PROJECT: "synthetic-test",
  LOG_BUCKET: "synthetic-test-private",
  PUBLIC_ORIGIN: "https://diagnostics.example.org",
  UPLOAD_SIGNER_EMAIL: "upload@synthetic-test.iam.gserviceaccount.com",
  SCHEDULER_EMAIL: "maintenance@synthetic-test.iam.gserviceaccount.com",
  SCHEDULER_AUDIENCE: "https://diagnostics.example.org",
  ALLOWED_DOMAINS: "example.org",
  SEED_ADMIN_EMAILS: "it@example.org",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  DEV_AUTH: "false",
  DEV_MEMORY: "true",
  RETENTION_DAYS: "90",
});
