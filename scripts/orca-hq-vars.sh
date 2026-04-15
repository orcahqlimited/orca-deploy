# ORCA HQ — environment variables
# Load with: source ~/orca-hq-vars.sh

export RG="rg-orcahq-uks"
export LOCATION="uksouth"
export KV="kv-orcahq-uks"
export ACR="orcahqacruks"
export SQL_SRV="orcahq-sql-uks"
export SQL_DB="orca-pii-vault"
export BLOB="orcahqblobsuks"
export AI="orcahq-gateway-insights"
export CAE="orcahq-cae-uks"
export MI="orca-gateway-mi"
export MI_PRINCIPAL="f20c5a70-7401-4e26-8a9c-37d6b2faaadf"
export MI_CLIENT="e0de1225-67f4-4298-aef7-a8d233a62540"
export QDRANT_STORAGE="orcahqqdrantstorage"
export TENANT="27525d97-58a8-4d55-ba8c-696f769f97f6"
export APP_ID="06570e63-9cb0-455e-9af4-483e97503880"
export GATEWAY_URL="https://gateway.orcahq.ai"
export QDRANT_URL="https://qdrant.icyplant-8c8bf272.uksouth.azurecontainerapps.io"

# Key Vault helpers (Mac Python TLS workaround)
kv_set() {
  TOKEN=$(az account get-access-token --resource https://vault.azure.net --query accessToken -o tsv)
  curl -s -X PUT \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"value\": \"$2\"}" \
    "https://kv-orcahq-uks.vault.azure.net/secrets/$1?api-version=7.4" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERROR'))"
}

kv_get() {
  TOKEN=$(az account get-access-token --resource https://vault.azure.net --query accessToken -o tsv)
  curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "https://kv-orcahq-uks.vault.azure.net/secrets/$1?api-version=7.4" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('value','ERROR'))"
}

# Saturday morning — push images to ACR
# az acr login --name orcahqacruks
# docker tag node:20-slim orcahqacruks.azurecr.io/node:20-slim
# docker push orcahqacruks.azurecr.io/node:20-slim
# docker tag qdrant/qdrant:latest orcahqacruks.azurecr.io/qdrant:latest
# docker push orcahqacruks.azurecr.io/qdrant:latest
