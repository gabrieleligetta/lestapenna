# ============================================================================
# Outputs — Valori utili dopo terraform apply
# ============================================================================

output "instance_public_ip" {
  description = "IP pubblico dell'istanza DnD Bot"
  value       = oci_core_instance.dnd_bot_server.public_ip
}

output "instance_id" {
  description = "OCID dell'istanza compute"
  value       = oci_core_instance.dnd_bot_server.id
}

output "vcn_id" {
  description = "OCID della VCN"
  value       = oci_core_vcn.dnd_bot.id
}

output "subnet_id" {
  description = "OCID della subnet"
  value       = oci_core_subnet.dnd_subnet.id
}

output "bucket_namespace" {
  description = "Namespace Object Storage"
  value       = data.oci_objectstorage_namespace.ns.namespace
}

output "bucket_recordings_name" {
  description = "Nome del bucket recordings"
  value       = oci_objectstorage_bucket.recordings.name
}

output "ssh_connection" {
  description = "Comando SSH per connettersi al server"
  value       = "ssh ubuntu@${oci_core_instance.dnd_bot_server.public_ip}"
}
