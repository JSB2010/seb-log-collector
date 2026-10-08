locals {
  catalog_indexes = jsondecode(file("${path.module}/indexes.json"))
}
resource "google_firestore_index" "catalog" {
  for_each    = local.catalog_indexes
  database    = google_firestore_database.catalog.name
  collection  = each.value.collection
  query_scope = "COLLECTION"
  dynamic "fields" {
    for_each = each.value.fields
    content {
      field_path   = fields.value.field_path
      order        = lookup(fields.value, "order", null)
      array_config = lookup(fields.value, "array_config", null)
    }
  }
}
resource "google_firestore_field" "ttl" {
  for_each   = toset(["devices", "collections", "collectionRequests", "sessionLinks", "auditEvents", "enrollmentBatches", "enrollmentRoster", "quotaWindows"])
  database   = google_firestore_database.catalog.name
  collection = each.key
  field      = "ttlAt"
  ttl_config {}
  index_config {}
}
