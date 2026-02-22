#!/bin/bash
# ============================================================================
# Import delle risorse OCI esistenti nello state di Terraform
# ============================================================================
# Eseguire DOPO terraform init e PRIMA di terraform plan
# Uso: cd terraform && bash import.sh
# ============================================================================

set -e

echo "🔄 Importazione risorse OCI esistenti nello state Terraform..."
echo ""

# --- Network ---
echo "📡 Importazione VCN..."
terraform import oci_core_vcn.dnd_bot \
  "ocid1.vcn.oc1.eu-milan-1.amaaaaaafbqxagyakcjc2oplzgpt7fpj4gmgxi7fyhlpv24mwgwt4xxq44kq"

echo "🌐 Importazione Internet Gateway..."
terraform import oci_core_internet_gateway.igw \
  "ocid1.internetgateway.oc1.eu-milan-1.aaaaaaaa5llt55nqawptwkcsb6u2d5m7cfwqjnnlqkz2grusxqq7dm3avtaq"

echo "🛤️  Importazione Default Route Table..."
terraform import oci_core_default_route_table.default_rt \
  "ocid1.routetable.oc1.eu-milan-1.aaaaaaaaz4npwdoanbzjuc7c5ex57pbstrr63fnn7a5ulmop6upuabx3d7za"

echo "🛡️  Importazione Default Security List..."
terraform import oci_core_default_security_list.default_sl \
  "ocid1.securitylist.oc1.eu-milan-1.aaaaaaaabmdx6mttwp2c7yhe7aqf7caohg52nbiq6byyxf77cjt3ktob552a"

echo "🔌 Importazione Subnet..."
terraform import oci_core_subnet.dnd_subnet \
  "ocid1.subnet.oc1.eu-milan-1.aaaaaaaackvahuoxwf2klcwtmtwl3y7a5zidrp73px7vfzn22jtv36og7nna"

# --- Compute ---
echo "🖥️  Importazione Istanza Compute..."
terraform import oci_core_instance.dnd_bot_server \
  "ocid1.instance.oc1.eu-milan-1.anwgsljrfbqxagychoq3kwnivpbjzbr6rf6sse4qmynlkfttr2j2dd4zrena"

# --- Object Storage ---
# Il formato di import per i bucket è: n/{namespace}/b/{bucketName}
echo "📦 Importazione Bucket recordings..."
terraform import oci_objectstorage_bucket.recordings \
  "n/axfwxfniq0xg/b/lestapenna-recordings"

echo "📦 Importazione Bucket recordings-test..."
terraform import oci_objectstorage_bucket.recordings_test \
  "n/axfwxfniq0xg/b/lestapenna-recordings-test"

echo ""
echo "✅ Importazione completata! Esegui 'terraform plan' per verificare."
