#!/usr/bin/env bash
set -euo pipefail
: "${GCP_ACCOUNT:?Set the authorized account; no global account is changed}"
: "${GCP_PROJECT:?Set project ID}"
: "${TFVARS:?Set an ignored operational tfvars path relative to infra}"
original_account=$(gcloud config get-value account 2>/dev/null)
export GOOGLE_OAUTH_ACCESS_TOKEN
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token --account="$GCP_ACCOUNT" --project="$GCP_PROJECT")
terraform -chdir=infra init
terraform -chdir=infra plan -var-file="$TFVARS" -out=../.local/deploy.tfplan
terraform -chdir=infra apply ../.local/deploy.tfplan
current_account=$(gcloud config get-value account 2>/dev/null)
[[ "$current_account" == "$original_account" ]] || { echo 'Global account unexpectedly changed' >&2; exit 1; }
