# ============================================================================
# Compute — VM.Standard.A1.Flex (Ampere ARM64, Free Tier)
# ============================================================================

resource "oci_core_instance" "dnd_bot_server" {
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  display_name        = var.instance_display_name
  shape               = var.instance_shape

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gb
  }

  source_details {
    source_type             = "image"
    source_id               = var.image_ocid
    boot_volume_size_in_gbs = var.boot_volume_size_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.dnd_subnet.id
    assign_public_ip = true
    display_name     = "DnD-Bot-Server"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key

    # Cloud-init: installa Docker, pulisce iptables Oracle, crea cartelle
    # NOTA: questo user_data viene eseguito SOLO al primo boot.
    # Terraform lo ignora nei piani successivi (vedi lifecycle.ignore_changes)
    user_data = base64encode(<<-EOF
      #!/bin/bash

      # --- 1. Aggiornamento Sistema e Pulizia Firewall Oracle ---
      apt-get update && apt-get upgrade -y
      iptables -F
      iptables -X
      iptables -t nat -F
      iptables -t nat -X
      iptables -t mangle -F
      iptables -t mangle -X
      netfilter-persistent save

      # --- 2. Installazione Docker & Docker Compose (ARM64) ---
      apt-get install -y apt-transport-https ca-certificates curl software-properties-common
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
      echo "deb [arch=arm64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

      apt-get update
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

      # --- 3. Configurazione Utente ---
      usermod -aG docker ubuntu

      # --- 4. Utility Extra e Cartelle ---
      apt-get install -y git htop unzip
      mkdir -p /home/ubuntu/lestapenna
      chown -R ubuntu:ubuntu /home/ubuntu/lestapenna

      echo "--- SETUP COMPLETATO: Docker è pronto ---"
    EOF
    )
  }

  # Previeni ricreazione accidentale dell'istanza
  # metadata e defined_tags cambiano encoding/valore tra apply — ignorarli è sicuro
  lifecycle {
    ignore_changes = [
      metadata,
      defined_tags,
      source_details,
      create_vnic_details[0].defined_tags,
      create_vnic_details[0].private_ip,
      create_vnic_details[0].nsg_ids,
    ]
  }
}
