# ============================================================================
# Object Storage — Bucket per recordings e test
# ============================================================================

# Data source per ottenere il namespace (richiesto da OCI Object Storage)
data "oci_objectstorage_namespace" "ns" {
  compartment_id = var.compartment_ocid
}

# --- Bucket principale (recordings) ---
resource "oci_objectstorage_bucket" "recordings" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = var.bucket_name
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
  versioning     = "Disabled"
}

# --- Bucket di test ---
resource "oci_objectstorage_bucket" "recordings_test" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = var.bucket_test_name
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
  versioning     = "Disabled"
}
