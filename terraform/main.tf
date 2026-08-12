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

  # Backend remoto nativo OCI (non S3-compatible). La configurazione è
  # deliberatamente VUOTA: un blocco backend non accetta variabili, quindi
  # qualunque valore scritto qui finirebbe nel repo. Il namespace di Object
  # Storage identifica la tenancy, e bucket e regione dicono dove vive lo
  # state di chi gira il progetto: sono dati della propria installazione, non
  # del progetto.
  #
  # Tutto — bucket, namespace, key, region, auth e le credenziali API — passa
  # da backend.hcl (gitignored, stesso pattern di terraform.tfvars):
  #
  #   cp backend.hcl.example backend.hcl   # poi riempirlo
  #   terraform init -backend-config=backend.hcl
  backend "oci" {}
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.api_key_fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}
