#!/usr/bin/env bash
set -euo pipefail
: "${GCP_ACCOUNT:?Set the authorized account}"
: "${GCP_PROJECT:?Set the deployment project}"
gcloud services enable \
  cloudresourcemanager.googleapis.com iam.googleapis.com \
  run.googleapis.com storage.googleapis.com firestore.googleapis.com \
  iamcredentials.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com monitoring.googleapis.com logging.googleapis.com \
  billingbudgets.googleapis.com \
  --account="$GCP_ACCOUNT" --project="$GCP_PROJECT" --quiet
