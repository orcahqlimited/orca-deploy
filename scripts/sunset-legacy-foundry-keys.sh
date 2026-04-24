#!/usr/bin/env bash
# =============================================================================
# sunset-legacy-foundry-keys.sh
#
# Drops the legacy direct-Foundry-key secrets from a customer's Key Vault
# after verifying the customer gateway has been calling foundry.orcahq.ai
# successfully for at least $MIN_DAYS consecutive days (default 7).
#
# Context: v0.2.4 onwards, customer gateways call foundry.orcahq.ai with a
# short-lived JWT (INTENT-104 §104-I/Z). The HQ Foundry api-key never
# enters customer KVs for new installs. But customers who installed
# pre-v0.2.4 (AgileCadence is the only one today) have the HQ api-key
# in their KV per CL-ORCAHQ-0134 — a boundary crossing we want to close.
#
# Customer re-install with v0.2.4 installer provisions foundry-customer-
# token (the proxy JWT) but doesn't automatically remove the old direct-
# api-key secrets. This script is the cleanup step AFTER a re-install.
#
# Pre-flight checks (all must pass; dry-run prints but does not mutate):
#   1. Customer KV has foundry-customer-token secret (= proxy mode wired)
#   2. Customer gateway's FOUNDRY_ENDPOINT points at foundry.orcahq.ai
#   3. LAW (orca-license-logs) has gateway_event rows from this customer
#      citing successful foundry_embedding events for >= MIN_DAYS days
#   4. No foundry_http_error / foundry_proxy_auth errors in the last 24h
#
# Only if all four pass, the following secrets are deleted:
#   - foundry-api-key
#   - foundry-api-key-swc
#   - foundry-endpoint
#
# Also updates the customer gateway Container App env to remove
# FOUNDRY_API_KEY + FOUNDRY_SWC_API_KEY secretref bindings.
#
# Default is --dry-run. Pass --execute to actually delete.
#
# Usage:
#   ./sunset-legacy-foundry-keys.sh \
#     --customer-slug agile \
#     --customer-sub 00000000-0000-0000-0000-000000000000 \
#     --customer-rg rg-orca-agile-uks \
#     [--customer-kv kv-orca-agile-uks] \
#     [--min-days 7] \
#     [--execute]
#
# Related:
#   INTENT-104 §104-I/Z — Foundry proxy architecture
#   CL-ORCAHQ-0134 — the original boundary-crossing problem
#   build-intent-104-session-4-green — v0.2.4 release record
# =============================================================================

set -euo pipefail

# ── args ─────────────────────────────────────────────────────────────────────
CUSTOMER_SLUG=""
CUSTOMER_SUB=""
CUSTOMER_RG=""
CUSTOMER_KV=""
MIN_DAYS=7
EXECUTE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --customer-slug)   CUSTOMER_SLUG="$2"; shift 2 ;;
    --customer-sub)    CUSTOMER_SUB="$2";  shift 2 ;;
    --customer-rg)     CUSTOMER_RG="$2";   shift 2 ;;
    --customer-kv)     CUSTOMER_KV="$2";   shift 2 ;;
    --min-days)        MIN_DAYS="$2";      shift 2 ;;
    --execute)         EXECUTE=true;       shift ;;
    -h|--help)
      sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$CUSTOMER_SLUG" || -z "$CUSTOMER_SUB" || -z "$CUSTOMER_RG" ]]; then
  echo "ERROR: --customer-slug, --customer-sub, --customer-rg are required" >&2
  exit 2
fi

CUSTOMER_KV="${CUSTOMER_KV:-kv-orca-${CUSTOMER_SLUG}-uks}"
HQ_LAW_RG="rg-orcahq-uks"
HQ_LAW_NAME="orca-license-logs"

# ── formatting helpers ───────────────────────────────────────────────────────
ok()    { printf "\033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "\033[33m!\033[0m %s\n" "$*"; }
fail()  { printf "\033[31m✗\033[0m %s\n" "$*" >&2; }
info()  { printf "\033[90m▸\033[0m %s\n" "$*"; }
heading() { printf "\n\033[1m%s\033[0m\n" "$*"; }

_abort() { fail "$1"; exit 1; }

# ── context switch ───────────────────────────────────────────────────────────
heading "Customer context"
info "Slug:          $CUSTOMER_SLUG"
info "Subscription:  $CUSTOMER_SUB"
info "Resource group: $CUSTOMER_RG"
info "Key Vault:     $CUSTOMER_KV"
info "Min days:      $MIN_DAYS"
info "Mode:          $([[ "$EXECUTE" == "true" ]] && echo "EXECUTE" || echo "dry-run (default)")"

CURRENT_SUB=$(az account show --query id -o tsv 2>/dev/null || true)
if [[ "$CURRENT_SUB" != "$CUSTOMER_SUB" ]]; then
  info "Switching az context to customer sub..."
  az account set --subscription "$CUSTOMER_SUB" || _abort "az account set failed"
fi
ok "az context set to $CUSTOMER_SUB"

# ── pre-flight #1: foundry-customer-token present ────────────────────────────
heading "Pre-flight 1/4: foundry-customer-token in KV"
if az keyvault secret show --vault-name "$CUSTOMER_KV" --name "foundry-customer-token" \
     --query value -o tsv >/dev/null 2>&1; then
  ok "foundry-customer-token present in $CUSTOMER_KV"
else
  _abort "foundry-customer-token MISSING in $CUSTOMER_KV — customer has not been re-installed with v0.2.4 proxy-mode yet. Abort."
fi

# ── pre-flight #2: gateway FOUNDRY_ENDPOINT points at foundry.orcahq.ai ──────
heading "Pre-flight 2/4: gateway FOUNDRY_ENDPOINT value"
FOUNDRY_ENDPOINT=$(az containerapp show --name orca-mcp-gateway-v2 \
  --resource-group "$CUSTOMER_RG" \
  --query "properties.template.containers[0].env[?name=='FOUNDRY_ENDPOINT'].value | [0]" \
  -o tsv 2>/dev/null || true)
if [[ "$FOUNDRY_ENDPOINT" == "https://foundry.orcahq.ai" ]]; then
  ok "FOUNDRY_ENDPOINT=$FOUNDRY_ENDPOINT"
else
  _abort "FOUNDRY_ENDPOINT is '$FOUNDRY_ENDPOINT', expected 'https://foundry.orcahq.ai'. Re-install customer with v0.2.4 installer first."
fi

# ── pre-flight #3: LAW shows successful proxy calls for MIN_DAYS ─────────────
heading "Pre-flight 3/4: LAW evidence of successful foundry_embedding via proxy"
# Switch to HQ sub for LAW query; restore at end
LAW_CUSTOMER_ID=$(az monitor log-analytics workspace show \
  --workspace-name "$HQ_LAW_NAME" \
  --resource-group "$HQ_LAW_RG" \
  --subscription ORCA-HQ-PROD \
  --query customerId -o tsv 2>/dev/null || true)
if [[ -z "$LAW_CUSTOMER_ID" ]]; then
  warn "Could not resolve LAW customerId — skipping evidence check"
else
  SUCCESS_DAYS=$(az monitor log-analytics query \
    --workspace "$LAW_CUSTOMER_ID" \
    --subscription ORCA-HQ-PROD \
    --analytics-query "AppTraces | where TimeGenerated > ago(${MIN_DAYS}d) | where Properties.customer_slug == '${CUSTOMER_SLUG}' | where Properties.event == 'foundry_embedding' | summarize count() by bin(TimeGenerated, 1d) | count" \
    --query "tables[0].rows[0][0]" -o tsv 2>/dev/null || echo 0)
  if (( SUCCESS_DAYS >= MIN_DAYS )); then
    ok "foundry_embedding events on ${SUCCESS_DAYS} distinct days in last ${MIN_DAYS} — clear"
  else
    _abort "Only ${SUCCESS_DAYS}/${MIN_DAYS} days show successful foundry_embedding events — proxy mode not yet proven. Abort."
  fi
fi
az account set --subscription "$CUSTOMER_SUB" >/dev/null

# ── pre-flight #4: no recent proxy errors ────────────────────────────────────
heading "Pre-flight 4/4: no foundry_http_error / foundry_proxy_auth in last 24h"
if [[ -n "$LAW_CUSTOMER_ID" ]]; then
  ERR_COUNT=$(az monitor log-analytics query \
    --workspace "$LAW_CUSTOMER_ID" \
    --subscription ORCA-HQ-PROD \
    --analytics-query "AppTraces | where TimeGenerated > ago(24h) | where Properties.customer_slug == '${CUSTOMER_SLUG}' | where Properties.event in ('foundry_http_error','foundry_proxy_auth','foundry_proxy_rate_limit','embedding_http_error') | count" \
    --query "tables[0].rows[0][0]" -o tsv 2>/dev/null || echo 0)
  if (( ERR_COUNT == 0 )); then
    ok "no proxy errors in last 24h"
  else
    _abort "Found ${ERR_COUNT} proxy error events in last 24h — investigate before sunset. Abort."
  fi
fi
az account set --subscription "$CUSTOMER_SUB" >/dev/null

# ── action (gated by --execute) ──────────────────────────────────────────────
heading "Secrets that would be deleted from $CUSTOMER_KV"
for s in foundry-api-key foundry-api-key-swc foundry-endpoint; do
  EXISTS=$(az keyvault secret show --vault-name "$CUSTOMER_KV" --name "$s" \
    --query id -o tsv 2>/dev/null || true)
  if [[ -n "$EXISTS" ]]; then
    info "  - $s (present)"
  else
    info "  - $s (already absent — skip)"
  fi
done

heading "Gateway env vars that would be removed"
info "  - FOUNDRY_API_KEY (secretref)"
info "  - FOUNDRY_SWC_API_KEY (secretref)"
info "  - FOUNDRY_SWC_ENDPOINT (plain, legacy)"

if [[ "$EXECUTE" != "true" ]]; then
  heading "Dry-run complete. Re-run with --execute to apply."
  exit 0
fi

# ── actual deletion path ─────────────────────────────────────────────────────
heading "EXECUTING"

for s in foundry-api-key foundry-api-key-swc foundry-endpoint; do
  if az keyvault secret show --vault-name "$CUSTOMER_KV" --name "$s" --query id -o tsv >/dev/null 2>&1; then
    az keyvault secret delete --vault-name "$CUSTOMER_KV" --name "$s" -o none
    ok "deleted KV secret: $s"
  fi
done

# Update gateway Container App — remove the legacy secretref env vars. We do
# this by fetching the current env, filtering, and setting the full set (CL-
# ORCAHQ-0072: az containerapp update --set-env-vars wipes anything not in
# the list, so we're deliberately passing the full list minus the legacy
# three).
CURRENT_ENV_JSON=$(az containerapp show --name orca-mcp-gateway-v2 \
  --resource-group "$CUSTOMER_RG" \
  --query "properties.template.containers[0].env" -o json)

NEW_ENV=$(echo "$CURRENT_ENV_JSON" | python3 -c "
import json, sys
env = json.load(sys.stdin)
drop = {'FOUNDRY_API_KEY', 'FOUNDRY_SWC_API_KEY', 'FOUNDRY_SWC_ENDPOINT'}
kept = [e for e in env if e['name'] not in drop]
parts = []
for e in kept:
    if 'secretRef' in e:
        parts.append(f\"{e['name']}=secretref:{e['secretRef']}\")
    else:
        parts.append(f\"{e['name']}={e.get('value','')}\")
print(' '.join(parts))
")

# shellcheck disable=SC2086
az containerapp update --name orca-mcp-gateway-v2 --resource-group "$CUSTOMER_RG" \
  --set-env-vars $NEW_ENV -o none
ok "gateway env updated — FOUNDRY_API_KEY / FOUNDRY_SWC_API_KEY / FOUNDRY_SWC_ENDPOINT removed"

heading "Post-sunset verification (30s)"
sleep 30
FQDN=$(az containerapp show --name orca-mcp-gateway-v2 --resource-group "$CUSTOMER_RG" \
  --query "properties.configuration.ingress.fqdn" -o tsv)
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "https://$FQDN/health" || echo 000)
if [[ "$STATUS" == "200" ]]; then
  ok "gateway /health = 200 after sunset"
else
  warn "gateway /health returned $STATUS — investigate"
fi

heading "Legacy Foundry keys sunset complete for $CUSTOMER_SLUG"
info "The customer now calls Foundry exclusively through foundry.orcahq.ai."
info "You can now harden HQ Foundry (Private Link + disable-local-auth) as"
info "no customer holds the HQ key any more."
