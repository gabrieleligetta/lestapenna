# ============================================================================
# Lestapenna — OCI Infrastructure as Code
# ============================================================================
# Questo file descrive l'infrastruttura Oracle Cloud esistente.
# Per allineare lo state con le risorse già create, eseguire import.sh
# ============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }

  # State locale — NON committare terraform.tfstate nel repo
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.api_key_fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}
