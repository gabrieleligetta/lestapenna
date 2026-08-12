#!/bin/bash
# ============================================================================
# Import delle risorse OCI esistenti nello state di Terraform
# ============================================================================
# Serve solo a chi ha già creato l'infrastruttura a mano e vuole portarla
# sotto Terraform senza ricrearla. Chi parte da zero non ha niente da
# importare: `terraform apply` e basta.
#
# Gli OCID sono identificatori della TUA tenancy: vanno in import.env, che
# non è tracciato. Copiare import.env.example, riempirlo con i valori che
# la console OCI mostra per ogni risorsa, e poi:
#
#   cd terraform && bash import.sh
#
# Eseguire DOPO terraform init e PRIMA di terraform plan.
# ============================================================================

set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f import.env ]; then
  echo "❌ import.env non trovato."
  echo "👉 cp import.env.example import.env, poi riempilo con gli OCID della tua tenancy."
  exit 1
fi

# shellcheck disable=SC1091
source ./import.env

# Un OCID mancante farebbe fallire `terraform import` a metà, lasciando lo
# state per metà popolato: meglio scoprirlo prima di iniziare.
required=(
  OS_NAMESPACE VCN_OCID IGW_OCID ROUTE_TABLE_OCID SECURITY_LIST_OCID
  SUBNET_OCID NSG_OCID NSG_RULE_EGRESS_ALL NSG_RULE_HTTP NSG_RULE_HTTPS
  INSTANCE_OCID BUCKET_RECORDINGS BUCKET_RECORDINGS_TEST BUCKET_DB_BACKUP
)
missing=()
for var in "${required[@]}"; do
  [ -n "${!var:-}" ] || missing+=("$var")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ Variabili mancanti in import.env: ${missing[*]}"
  exit 1
fi

echo "🔄 Importazione risorse OCI esistenti nello state Terraform..."
echo ""

# --- Network ---
echo "📡 Importazione VCN..."
terraform import oci_core_vcn.dnd_bot "$VCN_OCID"

echo "🌐 Importazione Internet Gateway..."
terraform import oci_core_internet_gateway.igw "$IGW_OCID"

echo "🛤️  Importazione Default Route Table..."
terraform import oci_core_default_route_table.default_rt "$ROUTE_TABLE_OCID"

echo "🛡️  Importazione Default Security List..."
terraform import oci_core_default_security_list.default_sl "$SECURITY_LIST_OCID"

echo "🔌 Importazione Subnet..."
terraform import oci_core_subnet.dnd_subnet "$SUBNET_OCID"

echo "🛡️  Importazione NSG ingress produzione..."
terraform import oci_core_network_security_group.prod_ingress "$NSG_OCID"

# Le regole di un NSG non hanno un OCID proprio: si importano col percorso
# networkSecurityGroups/{ocid}/securityRules/{id}, dove l'id è il codice
# esadecimale che la console mostra accanto alla regola.
echo "↗️  Importazione regola egress NSG..."
terraform import oci_core_network_security_group_security_rule.prod_egress_all \
  "networkSecurityGroups/$NSG_OCID/securityRules/$NSG_RULE_EGRESS_ALL"

echo "🌐 Importazione regola HTTP NSG..."
terraform import oci_core_network_security_group_security_rule.prod_http \
  "networkSecurityGroups/$NSG_OCID/securityRules/$NSG_RULE_HTTP"

echo "🔒 Importazione regola HTTPS NSG..."
terraform import oci_core_network_security_group_security_rule.prod_https \
  "networkSecurityGroups/$NSG_OCID/securityRules/$NSG_RULE_HTTPS"

# --- Compute ---
echo "🖥️  Importazione Istanza Compute..."
terraform import oci_core_instance.dnd_bot_server "$INSTANCE_OCID"

# --- Object Storage ---
# Il formato di import per i bucket è: n/{namespace}/b/{bucketName}
echo "📦 Importazione Bucket recordings..."
terraform import oci_objectstorage_bucket.recordings "n/$OS_NAMESPACE/b/$BUCKET_RECORDINGS"

echo "📦 Importazione Bucket recordings-test..."
terraform import oci_objectstorage_bucket.recordings_test "n/$OS_NAMESPACE/b/$BUCKET_RECORDINGS_TEST"

echo "📦 Importazione Bucket DB Backup..."
terraform import oci_objectstorage_bucket.db_backup "n/$OS_NAMESPACE/b/$BUCKET_DB_BACKUP"

echo ""
echo "✅ Importazione completata! Esegui 'terraform plan' per verificare."
echo "ℹ️  Il bucket di stato remoto non esiste ancora: il primo plan deve"
echo "   proporre soltanto la sua creazione, oltre a eventuali drift reali da revisionare."
