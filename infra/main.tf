locals {
  notification_channels = concat(var.notification_channel_ids, google_monitoring_notification_channel.operator[*].name)
  service_env = {

    GOOGLE_CLOUD_PROJECT = var.project_id
    LOG_BUCKET           = var.bucket_name
    PUBLIC_ORIGIN        = var.public_origin
    UPLOAD_SIGNER_EMAIL  = google_service_account.signer.email
    SCHEDULER_EMAIL      = google_service_account.scheduler.email
    SCHEDULER_AUDIENCE   = var.public_origin
    ALLOWED_DOMAINS      = var.allowed_domains
    SEED_ADMIN_EMAILS    = var.seed_admin_emails
    GOOGLE_CLIENT_ID     = var.oauth_client_id

  }

}

resource "google_monitoring_notification_channel" "operator" {
  count        = var.notification_email == "" ? 0 : 1
  display_name = "Diagnostics operator"
  type         = "email"
  labels       = { email_address = var.notification_email }
}

resource "google_storage_bucket" "logs" {

  name                        = var.bucket_name
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning {
    enabled = false
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  lifecycle_rule {
    condition {
      age = 90
    }

    action {
      type = "Delete"
    }

  }

  labels = {
    application = "soe-diagnostics", data = "private-client-logs"
  }


}

resource "google_firestore_database" "catalog" {

  name                              = "(default)"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "PESSIMISTIC"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_DISABLED"

}

resource "google_service_account" "runtime" {
  account_id   = "diagnostics-runtime"
  display_name = "Diagnostics runtime"
}

resource "google_service_account" "signer" {
  account_id   = "diagnostics-upload"
  display_name = "Create-only upload policy signer"
}

resource "google_service_account" "scheduler" {
  account_id   = "diagnostics-maintenance"
  display_name = "Maintenance OIDC identity"
}

resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_custom_role" "log_access" {
  role_id     = "diagnosticsLogAccess"
  title       = "Verified log access"
  permissions = ["storage.objects.get", "storage.objects.delete"]
}

resource "google_project_iam_custom_role" "sign_blob" {
  role_id     = "diagnosticsSignBlob"
  title       = "Upload policy signing only"
  permissions = ["iam.serviceAccounts.signBlob"]
}

resource "google_storage_bucket_iam_member" "runtime_logs" {
  bucket = google_storage_bucket.logs.name
  role   = google_project_iam_custom_role.log_access.name
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket_iam_member" "create_only" {
  bucket = google_storage_bucket.logs.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.signer.email}"
}

resource "google_service_account_iam_member" "signer" {
  service_account_id = google_service_account.signer.name
  role               = google_project_iam_custom_role.sign_blob.name
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret" "secret" {

  for_each  = toset(["diagnostics-session", "diagnostics-oauth-client-secret", "diagnostics-integration"])
  secret_id = each.key
  replication {
    auto {

    }

  }


}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = google_secret_manager_secret.secret
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_artifact_registry_repository" "containers" {
  location               = var.region
  repository_id          = "diagnostics"
  format                 = "DOCKER"
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 3
    }

  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "604800s"
    }

  }

}

resource "google_cloud_run_v2_service" "web" {

  count               = var.create_service ? 1 : 0
  name                = var.service_name
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  template {

    service_account                  = google_service_account.runtime.email
    timeout                          = "300s"
    max_instance_request_concurrency = 8
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {

      image = var.image
      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu = "1", memory = "1Gi"
        }

        cpu_idle          = true
        startup_cpu_boost = false
      }

      dynamic "env" {
        for_each = local.service_env
        content {
          name  = env.key
          value = env.value
        }

      }

      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["diagnostics-session"].secret_id
            version = "latest"
          }

        }

      }

      dynamic "env" {
        for_each = var.oauth_secret_enabled ? [1] : []
        content {
          name = "GOOGLE_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secret["diagnostics-oauth-client-secret"].secret_id
              version = "latest"
            }

          }

        }

      }

      dynamic "env" {
        for_each = var.integration_secret_enabled ? [1] : []
        content {
          name = "INTEGRATION_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secret["diagnostics-integration"].secret_id
              version = "latest"
            }

          }

        }

      }

      startup_probe {
        http_get {
          path = "/api/health"
          port = 8080
        }

        initial_delay_seconds = 2
        period_seconds        = 5
        failure_threshold     = 12
        timeout_seconds       = 3
      }


    }


  }

  depends_on = [google_secret_manager_secret_iam_member.runtime, google_project_iam_member.firestore]

}

resource "google_cloud_run_v2_service_iam_member" "public_ingress" {
  count    = var.create_service ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_scheduler_job" "maintenance" {

  count            = var.create_service ? 1 : 0
  name             = "diagnostics-maintenance"
  region           = var.region
  schedule         = "17 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "300s"
  retry_config {
    retry_count          = 3
    min_backoff_duration = "30s"
    max_backoff_duration = "300s"
  }

  http_target {
    uri         = "${var.public_origin}/api/internal/v1/maintenance"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.public_origin
    }

  }


}

resource "google_monitoring_alert_policy" "server_errors" {

  display_name          = "Diagnostics repeated server errors"
  combiner              = "OR"
  notification_channels = local.notification_channels
  conditions {
    display_name = "HTTP 5xx"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.label.service_name = \"${var.service_name}\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.label.response_code_class = \"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

    }

  }


}

resource "google_monitoring_alert_policy" "cleanup_overdue" {
  display_name          = "Diagnostics expired artifact cleanup overdue"
  combiner              = "OR"
  notification_channels = local.notification_channels
  conditions {
    display_name = "Expired bytes retained for more than 24 hours"
    condition_matched_log {
      filter = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.service_name}\" AND jsonPayload.event = \"cleanup_overdue\""
    }
  }
  alert_strategy {
    notification_rate_limit { period = "300s" }
    auto_close = "604800s"
  }
}

resource "google_billing_budget" "project" {

  count           = var.billing_account != "" ? 1 : 0
  billing_account = var.billing_account
  display_name    = "Diagnostics pilot budget (alerts only)"
  budget_filter {
    projects = ["projects/${data.google_project.current.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount)
    }

  }

  threshold_rules {
    threshold_percent = 0.5
  }

  threshold_rules {
    threshold_percent = 0.8
  }

  threshold_rules {
    threshold_percent = 1.0
  }

  all_updates_rule {
    monitoring_notification_channels = local.notification_channels
    disable_default_iam_recipients   = false
  }


}

data "google_project" "current" {

}
