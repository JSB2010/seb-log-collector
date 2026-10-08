variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "bucket_name" {
  type = string
}

variable "service_name" {
  type    = string
  default = "soe-diagnostics"
}

variable "image" {
  type    = string
  default = ""
}

variable "create_service" {
  type    = bool
  default = false
}

variable "public_origin" {
  type    = string
  default = ""
}

variable "allowed_domains" {
  type = string
}

variable "seed_admin_emails" {
  type = string
}

variable "oauth_client_id" {
  type    = string
  default = ""
}

variable "oauth_secret_enabled" {
  type    = bool
  default = false
}

variable "integration_secret_enabled" {
  type    = bool
  default = false
}

variable "budget_amount" {
  type    = number
  default = 20
}

variable "billing_account" {
  type    = string
  default = ""
}

variable "notification_channel_ids" {
  description = "Existing verified Monitoring notification channels for operational alerts."
  type        = list(string)
  default     = []
}

variable "notification_email" {
  description = "Optional operator email for monitoring alerts."
  type        = string
  default     = ""
}
