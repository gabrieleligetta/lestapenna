# ============================================================================
# Variabili — I valori vengono dal file terraform.tfvars (gitignored)
# ============================================================================

# --- Autenticazione OCI ---

variable "tenancy_ocid" {
  description = "OCID del tenancy OCI"
  type        = string
  sensitive   = true
}

variable "user_ocid" {
  description = "OCID dell'utente OCI"
  type        = string
  sensitive   = true
}

variable "api_key_fingerprint" {
  description = "Fingerprint della API key OCI"
  type        = string
  sensitive   = true
}

variable "private_key_path" {
  description = "Path alla private key per l'autenticazione API OCI"
  type        = string
  default     = "~/.oci/oci_api_key.pem"
}

variable "region" {
  description = "Region OCI"
  type        = string
  default     = "eu-milan-1"
}

# --- Compartment ---

variable "compartment_ocid" {
  description = "OCID del compartment (default = root tenancy)"
  type        = string
}

# --- Compute ---

variable "instance_display_name" {
  description = "Nome visualizzato dell'istanza compute"
  type        = string
  default     = "DnD-Bot-Server"
}

variable "instance_shape" {
  description = "Shape dell'istanza (Free Tier: VM.Standard.A1.Flex)"
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  description = "Numero di OCPU (Free Tier: max 4)"
  type        = number
  default     = 4
}

variable "instance_memory_gb" {
  description = "RAM in GB (Free Tier: max 24)"
  type        = number
  default     = 24
}

variable "boot_volume_size_gb" {
  description = "Dimensione boot volume in GB (Free Tier: max 200)"
  type        = number
  default     = 200
}

variable "availability_domain" {
  description = "Availability Domain"
  type        = string
}

variable "image_ocid" {
  description = "OCID dell'immagine OS (Ubuntu su ARM)"
  type        = string
}

variable "ssh_public_key" {
  description = "Chiave pubblica SSH per accesso all'istanza"
  type        = string
  sensitive   = true
}

variable "ssh_allowed_cidr" {
  description = "IPv4 CIDR allowed to reach SSH; use the administrator's public IP with /32"
  type        = string

  validation {
    condition     = can(cidrnetmask(var.ssh_allowed_cidr)) && var.ssh_allowed_cidr != "0.0.0.0/0"
    error_message = "ssh_allowed_cidr must be a valid IPv4 CIDR and cannot expose SSH to 0.0.0.0/0."
  }
}

# --- Network ---

variable "vcn_cidr" {
  description = "CIDR block della VCN"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block della subnet"
  type        = string
  default     = "10.0.0.0/24"
}

# --- Object Storage ---

variable "bucket_name" {
  description = "Nome del bucket Object Storage principale"
  type        = string
  default     = "lestapenna-recordings"
}

variable "bucket_media_name" {
  description = "Nome del bucket Object Storage privato per le immagini delle entità"
  type        = string
  default     = "lestapenna-media"
}

variable "bucket_test_name" {
  description = "Nome del bucket Object Storage di test"
  type        = string
  default     = "lestapenna-recordings-test"
}

variable "bucket_db_backup_name" {
  description = "Nome del bucket Object Storage per i backup Litestream SQLite"
  type        = string
  default     = "lestapenna-db-backup"
}

variable "bucket_tf_state_name" {
  description = "Nome del bucket Object Storage per Terraform remote state"
  type        = string
  default     = "lestapenna-tf-state"
}

variable "domain" {
  description = "Dominio per il reverse proxy Caddy (Let's Encrypt TLS)"
  type        = string
  default     = ""
}
