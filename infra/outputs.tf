output "runtime_email" {
  value = google_service_account.runtime.email
}

output "signer_email" {
  value = google_service_account.signer.email
}

output "service_url" {
  value = var.create_service ? google_cloud_run_v2_service.web[0].uri : ""
}

output "registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}"
}

