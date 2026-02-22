# ============================================================================
# Network — VCN, Subnet, Internet Gateway, Route Table, Security List
# ============================================================================

# --- VCN ---
resource "oci_core_vcn" "dnd_bot" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "dndBot"
  dns_label      = "dndnet"
}

# --- Internet Gateway ---
resource "oci_core_internet_gateway" "igw" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.dnd_bot.id
  display_name   = "ig-quick-action-IGW"
  enabled        = true
}

# --- Default Route Table (0.0.0.0/0 → IGW) ---
resource "oci_core_default_route_table" "default_rt" {
  manage_default_resource_id = oci_core_vcn.dnd_bot.default_route_table_id
  display_name               = "Default Route Table for dndBot"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.igw.id
  }
}

# --- Default Security List ---
resource "oci_core_default_security_list" "default_sl" {
  manage_default_resource_id = oci_core_vcn.dnd_bot.default_security_list_id
  display_name               = "Default Security List for dndBot"

  # Tutto il traffico in uscita
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
    stateless   = false
  }

  # SSH da ovunque (porta 22)
  ingress_security_rules {
    protocol  = "6" # TCP
    source    = "0.0.0.0/0"
    stateless = false

    tcp_options {
      min = 22
      max = 22
    }
  }

  # ICMP tipo 3, codice 4 (Fragmentation Needed) da ovunque
  ingress_security_rules {
    protocol  = "1" # ICMP
    source    = "0.0.0.0/0"
    stateless = false

    icmp_options {
      type = 3
      code = 4
    }
  }

  # ICMP tipo 3 (Destination Unreachable) dalla VCN
  ingress_security_rules {
    protocol  = "1" # ICMP
    source    = var.vcn_cidr
    stateless = false

    icmp_options {
      type = 3
    }
  }
}

# --- Subnet pubblica ---
resource "oci_core_subnet" "dnd_subnet" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.dnd_bot.id
  cidr_block                 = var.subnet_cidr
  display_name               = "dnd-subnet"
  dns_label                  = "dndsubnet"
  prohibit_internet_ingress  = false
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_vcn.dnd_bot.default_route_table_id
  security_list_ids          = [oci_core_vcn.dnd_bot.default_security_list_id]
}
