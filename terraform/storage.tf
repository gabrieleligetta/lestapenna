# ============================================================================
# Object Storage — Bucket per recordings, media entità, test e infrastruttura
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

# --- Bucket privato per immagini delle entità della webapp ---
resource "oci_objectstorage_bucket" "media" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = var.bucket_media_name
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

# --- Bucket Litestream DB Backup ---
resource "oci_objectstorage_bucket" "db_backup" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = var.bucket_db_backup_name
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
  versioning     = "Disabled"
}

# --- Bucket Terraform State (remote backend) ---
resource "oci_objectstorage_bucket" "tf_state" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = var.bucket_tf_state_name
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
  versioning     = "Enabled"
}
