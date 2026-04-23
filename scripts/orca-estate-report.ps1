# =============================================================================
# orca-estate-report.ps1
# -----------------------------------------------------------------------------
# Produces a human-readable report of a customer's ORCA deployment state.
#
# USAGE:
#   .\orca-estate-report.ps1 agile uksouth
#   .\orca-estate-report.ps1 agile uksouth -Detailed
#   .\orca-estate-report.ps1 agile uksouth -Save report.md
#
# WHAT IT CHECKS:
#   - Resource groups + resource inventory
#   - Key Vault secrets (names + shapes only, never values)
#   - Key Vault RSA keys
#   - Managed Identity + its role assignments
#   - Entra app registration + roles + redirect URIs
#   - Container Apps (running state + image tags)
#   - AKS cluster + Qdrant service + collection point counts
#   - SQL Server + database + table list
#   - Gateway /health endpoint
#   - Custom domain binding (if any)
#   - Final summary with ✓ / ⚠ / ✗ counts
#
# RUNS ENTIRELY READ-ONLY. Mutates nothing. Safe to run at any time.
# Requires az CLI logged in to the customer tenant.
# =============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$CustomerSlug,

    [Parameter(Mandatory=$true, Position=1)]
    [string]$Region,

    [switch]$Detailed,

    [string]$Save
)

$ErrorActionPreference = 'Continue'

# ───── Region short code map (mirrors src/types.ts REGIONS) ─────
$regionShortMap = @{
    'uksouth'        = 'uks'
    'ukwest'         = 'ukw'
    'westeurope'     = 'weu'
    'northeurope'    = 'neu'
    'eastus'         = 'eus'
    'eastus2'        = 'eu2'
    'westus2'        = 'wu2'
    'australiaeast'  = 'aue'
    'southeastasia'  = 'sea'
}
if (-not $regionShortMap.ContainsKey($Region)) {
    Write-Error "Unknown region '$Region'. Add it to \$regionShortMap at the top of this script."
    exit 1
}
$rs = $regionShortMap[$Region]

# ───── Naming convention (mirrors src/utils/naming.ts) ─────
$rg       = "rg-orca-$CustomerSlug-$rs"
$aksRg    = "rg-orca-$CustomerSlug-aks-$rs"
$kv       = "kv-orca-$CustomerSlug-$rs"
$acr      = "orca$CustomerSlug" + "acr$rs"
$mi       = "orca-$CustomerSlug-mi"
$cae      = "orca-$CustomerSlug-cae-$rs"
$vnet     = "vnet-orca-$CustomerSlug-$rs"
$aks      = "orca-$CustomerSlug-aks-$rs"
$sqlSrv   = "orca-$CustomerSlug-sql-$rs"
$storage  = "orca$CustomerSlug" + "blobs"
$entraApp = "ORCA Intelligence Connectors"

# ───── Report accumulator ─────
$lines = [System.Collections.ArrayList]@()
$pass  = 0
$warn  = 0
$fail  = 0

function Say($text) {
    [void]$lines.Add($text)
}
function Ok($text) {
    Say "  ✓ $text"
    $script:pass++
}
function Warn($text) {
    Say "  ⚠ $text"
    $script:warn++
}
function Fail($text) {
    Say "  ✗ $text"
    $script:fail++
}
function Heading($text) {
    Say ""
    Say "═══ $text ═══"
}

# ───── Header ─────
Say "ORCA ESTATE REPORT — $CustomerSlug / $Region"
Say "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
Say "Run by:    $((az account show --query user.name -o tsv 2>$null))"
Say "Tenant:    $((az account show --query tenantId -o tsv 2>$null))"
Say "Subscription: $((az account show --query name -o tsv 2>$null))"
Say ""
Say ("─" * 70)

# ───── [1] Resource groups ─────
Heading "[1/10] RESOURCE GROUPS"
foreach ($group in @($rg, $aksRg)) {
    $exists = az group exists --name $group 2>$null
    if ($exists -eq 'true') {
        $resourceCount = (az resource list -g $group --query "length(@)" -o tsv 2>$null)
        Ok "$group ($resourceCount resources)"
    } else {
        Fail "$group — not found"
    }
}

# ───── [2] Key Vault secrets ─────
Heading "[2/10] KEY VAULT"
$kvExists = az keyvault show --name $kv --query name -o tsv 2>$null
if (-not $kvExists) {
    Fail "$kv — not found"
} else {
    Say "  Vault: $kv"
    $secrets = az keyvault secret list --vault-name $kv --query "[].name" -o tsv 2>$null
    $secretArr = @($secrets -split "`n" | Where-Object { $_ })
    Say "  Secrets present: $($secretArr.Count)"

    # Must-have secrets for a healthy customer install
    $expected = @(
        'orca-license-master',
        'pii-encryption-key',
        'sql-connection-string',
        'sql-admin-password',
        'foundry-endpoint',
        'foundry-api-key',
        'foundry-api-key-swc',
        'entra-client-secret',
        'heartbeat-secret',
        'graph-webhook-client-state'
    )
    foreach ($name in $expected) {
        if ($secretArr -contains $name) {
            # Read length only, never the value
            $val = az keyvault secret show --vault-name $kv --name $name --query value -o tsv 2>$null
            if ($name -eq 'orca-license-master') {
                $parts = ($val -split '\.').Length
                if ($parts -eq 3) { Ok "$name (JWT, 3 parts — valid shape)" }
                else { Fail "$name (JWT has $parts parts — expected 3)" }
            } elseif ($name -eq 'pii-encryption-key') {
                if ($val -match '^[0-9a-fA-F]{64}$') { Ok "$name (64 hex chars — AES-256)" }
                else { Fail "$name (length $($val.Length) — expected 64 hex chars)" }
            } elseif ($name -eq 'sql-connection-string') {
                $server = ($val -split ';' | Where-Object { $_ -like 'Server=*' })
                if ($server -and $server -notmatch '<|>') { Ok "$name ($server)" }
                else { Fail "$name (malformed — $server)" }
            } else {
                Ok "$name (present, length $($val.Length))"
            }
        } else {
            Fail "$name — missing"
        }
    }

    # Flag any unexpected secrets
    $unexpected = $secretArr | Where-Object { $_ -notin $expected -and $_ -notlike 'orca-license-*' -and $_ -notlike 'customer-licence-*' -and $_ -notlike 'freeagent-*' -and $_ -notlike 'freshdesk-*' -and $_ -notlike 'freshsales-*' -and $_ -notlike 'isms-*' -and $_ -notlike 'ado-*' -and $_ -notlike 'entra-*' -and $_ -notlike 'security-connector-*' -and $_ -notlike 'orca-signing-*' -and $_ -notlike 'graph-*' -and $_ -notlike 'app-*' -and $_ -notlike 'copilot-*' }
    if ($Detailed -and $unexpected.Count -gt 0) {
        Say "  Other secrets (informational):"
        foreach ($u in $unexpected) { Say "    · $u" }
    }
}

# ───── [3] Key Vault RSA key (orca-kek) ─────
Heading "[3/10] KEY VAULT RSA KEYS"
$kek = az keyvault key show --vault-name $kv --name orca-kek --query "{kty:key.kty, kid:key.kid, ops:key.key_ops}" -o json 2>$null | ConvertFrom-Json
if ($kek) {
    $ops = ($kek.ops -join ',')
    if ($kek.kty -eq 'RSA' -and $ops -match 'wrapKey' -and $ops -match 'unwrapKey') {
        Ok "orca-kek (RSA, ops: $ops)"
    } else {
        Fail "orca-kek exists but wrong type/ops (kty=$($kek.kty), ops=$ops)"
    }
} else {
    Fail "orca-kek — not found"
}

# ───── [4] Managed Identity + role assignments ─────
Heading "[4/10] MANAGED IDENTITY"
$miId = az identity show -g $rg -n $mi --query principalId -o tsv 2>$null
if (-not $miId) {
    Fail "$mi — not found"
} else {
    Say "  Identity: $mi"
    Say "  Principal ID: $miId"
    $roles = az role assignment list --assignee $miId --all --query "[].{role:roleDefinitionName, scope:scope}" -o json 2>$null | ConvertFrom-Json
    $needed = @(
        @{ role='Key Vault Secrets User';          scopePattern='*'+$kv },
        @{ role='Key Vault Crypto User';           scopePattern='*'+$kv },
        @{ role='Storage Blob Data Contributor';   scopePattern='*'+$storage },
        @{ role='AcrPull';                         scopePattern='*'+$acr }
    )
    foreach ($n in $needed) {
        $match = $roles | Where-Object { $_.role -eq $n.role -and $_.scope -like $n.scopePattern }
        if ($match) {
            Ok "$($n.role) on $(Split-Path $match.scope -Leaf)"
        } else {
            Fail "$($n.role) missing (expected scope: $($n.scopePattern))"
        }
    }
    if ($Detailed) {
        Say "  All role assignments:"
        foreach ($r in $roles) {
            Say "    · $($r.role) → $(Split-Path $r.scope -Leaf)"
        }
    }
}

# ───── [5] Entra app ─────
Heading "[5/10] ENTRA APP REGISTRATION"
$app = az ad app list --display-name $entraApp --query "[0]" -o json 2>$null | ConvertFrom-Json
if (-not $app) {
    Fail "`"$entraApp`" — not found"
} else {
    Say "  App: $entraApp"
    Say "  AppId: $($app.appId)"
    Say "  Sign-in audience: $($app.signInAudience)"

    $roleCount = ($app.appRoles | Measure-Object).Count
    if ($roleCount -ge 5) {
        Ok "App roles: $roleCount defined"
        foreach ($r in $app.appRoles) {
            Say "    · $($r.displayName) ($($r.value))"
        }
    } else {
        Fail "App roles: $roleCount — expected 5 (CL-ORCAHQ-0132)"
    }

    $webCount = ($app.web.redirectUris | Measure-Object).Count
    $spaCount = ($app.spa.redirectUris | Measure-Object).Count
    Ok "Redirect URIs — web: $webCount, spa: $spaCount"

    if ($app.spa.redirectUris -contains 'https://claude.ai/api/mcp/auth_callback') {
        Ok "claude.ai callback under SPA (correct for PKCE)"
    } elseif ($app.web.redirectUris -contains 'https://claude.ai/api/mcp/auth_callback') {
        Fail "claude.ai callback under WEB — should be SPA (CL-ORCAHQ-0133)"
    } else {
        Fail "claude.ai callback not registered"
    }
}

# ───── [6] Container Apps ─────
Heading "[6/10] CONTAINER APPS"
$cas = az containerapp list -g $rg --query "[].{name:name, image:properties.template.containers[0].image, running:properties.runningStatus, rev:properties.latestRevisionName}" -o json 2>$null | ConvertFrom-Json
if (-not $cas -or $cas.Count -eq 0) {
    Fail "No Container Apps found in $rg"
} else {
    $expectedCore = @('orca-mcp-gateway', 'orca-copilot', 'orca-governance-portal', 'orca-governance-connector')
    foreach ($name in $expectedCore) {
        $ca = $cas | Where-Object { $_.name -eq $name }
        if ($ca) {
            $tag = ($ca.image -split ':')[-1]
            if ($ca.running -eq 'Running') {
                Ok "$name — Running ($tag)"
            } else {
                Warn "$name — $($ca.running) ($tag)"
            }
        } else {
            Fail "$name — not deployed"
        }
    }
    $connectors = $cas | Where-Object { $_.name -like '*-connector' }
    Say "  Connectors ($($connectors.Count)):"
    foreach ($c in $connectors) {
        $tag = ($c.image -split ':')[-1]
        Say "    · $($c.name) ($tag, $($c.running))"
    }
}

# ───── [7] AKS + Qdrant ─────
Heading "[7/10] AKS + QDRANT"
$aksState = az aks show -g $aksRg -n $aks --query "{state:provisioningState, power:powerState.code, k8s:kubernetesVersion}" -o json 2>$null | ConvertFrom-Json
if (-not $aksState) {
    Fail "AKS $aks — not found"
} else {
    Say "  Cluster: $aks (K8s $($aksState.k8s), $($aksState.power))"
    if ($aksState.state -ne 'Succeeded') { Warn "Provisioning state: $($aksState.state)" }

    # Get Qdrant service via `az aks command invoke` — known-good pattern from runbook
    $svcOut = az aks command invoke -g $aksRg -n $aks --command "kubectl -n qdrant get svc qdrant -o jsonpath='{.spec.type},{.status.loadBalancer.ingress[0].ip}'" -o json 2>$null | ConvertFrom-Json
    if ($svcOut -and $svcOut.logs) {
        $svcParts = $svcOut.logs.Trim() -split ','
        $svcType = $svcParts[0]
        $svcVip  = $svcParts[1]
        if ($svcVip -match '^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^192\.168\.') {
            Ok "Qdrant svc: $svcType, VIP $svcVip (internal, RFC 1918)"
        } elseif ($svcVip) {
            Warn "Qdrant svc: $svcType, VIP $svcVip (NOT internal — CL-ORCAHQ-0126)"
        } else {
            Warn "Qdrant svc: $svcType, VIP pending"
        }

        # Collection point counts
        $collsOut = az aks command invoke -g $aksRg -n $aks --command "kubectl -n qdrant exec qdrant-0 -c qdrant -- curl -s http://localhost:6333/collections" -o json 2>$null | ConvertFrom-Json
        if ($collsOut -and $collsOut.logs) {
            $colls = ($collsOut.logs | ConvertFrom-Json).result.collections
            Say "  Collections ($($colls.Count)):"
            foreach ($c in $colls) {
                $cntOut = az aks command invoke -g $aksRg -n $aks --command "kubectl -n qdrant exec qdrant-0 -c qdrant -- curl -s http://localhost:6333/collections/$($c.name)" -o json 2>$null | ConvertFrom-Json
                $cnt = ($cntOut.logs | ConvertFrom-Json).result.points_count
                Say "    · $($c.name): $cnt points"
            }
        }
    } else {
        Warn "Could not query Qdrant service state"
    }
}

# ───── [8] SQL ─────
Heading "[8/10] SQL SERVER + PII VAULT"
$sql = az sql server show -g $rg -n $sqlSrv --query "{fqdn:fullyQualifiedDomainName, state:state, publicAccess:publicNetworkAccess}" -o json 2>$null | ConvertFrom-Json
if (-not $sql) {
    Fail "$sqlSrv — not found (CL-ORCAHQ-0129 — installer may not have provisioned SQL)"
} else {
    Say "  Server: $($sql.fqdn)"
    Ok "State: $($sql.state)"
    Say "  Public access: $($sql.publicAccess)"
    $db = az sql db show -g $rg -s $sqlSrv -n 'orca-pii-vault' --query "{name:name, status:status, tier:sku.tier}" -o json 2>$null | ConvertFrom-Json
    if ($db) {
        Ok "Database orca-pii-vault ($($db.tier), $($db.status))"
    } else {
        Fail "orca-pii-vault database — not found"
    }
}

# ───── [9] Gateway health ─────
Heading "[9/10] GATEWAY HEALTH"
$fqdn = az containerapp show -g $rg -n orca-mcp-gateway --query properties.configuration.ingress.fqdn -o tsv 2>$null
if ($fqdn) {
    Say "  FQDN: $fqdn"
    try {
        $health = Invoke-RestMethod -Uri "https://$fqdn/health" -Method Get -TimeoutSec 10
        if ($health.status -eq 'ok') { Ok "status: ok" } else { Fail "status: $($health.status)" }
        if ($health.pii_vault.connected) { Ok "pii_vault.connected: true" } else { Fail "pii_vault.connected: false" }
        if ($health.pii_vault.encryption_configured) { Ok "pii_vault.encryption_configured: true" } else { Fail "pii_vault.encryption_configured: false" }
        Say "  Collections declared: $($health.collections -join ', ')"
        Say "  Transport: $($health.transport -join ', ')"
    } catch {
        Fail "Could not reach /health: $($_.Exception.Message)"
    }
} else {
    Fail "orca-mcp-gateway — no ingress FQDN (not deployed or still starting)"
}

# ───── [10] Custom domain ─────
Heading "[10/10] CUSTOM DOMAIN"
$customHostnames = az containerapp hostname list -g $rg -n orca-mcp-gateway --query "[].{hostname:name, binding:bindingType}" -o json 2>$null | ConvertFrom-Json
if ($customHostnames -and $customHostnames.Count -gt 0) {
    foreach ($h in $customHostnames) {
        Ok "$($h.hostname) ($($h.binding))"
    }
} else {
    Say "  (none — using Azure-assigned FQDN)"
}

# ───── Summary ─────
Say ""
Say ("─" * 70)
Say "SUMMARY: $pass passed, $warn warnings, $fail failed"
Say ""
if ($fail -eq 0 -and $warn -eq 0) {
    Say "✅ Estate looks fully healthy. Nothing to flag."
} elseif ($fail -eq 0) {
    Say "⚠ Estate is functional but has $warn non-blocking items flagged above."
} else {
    Say "✗ Estate has $fail critical issues. See flags above."
}

# ───── Emit ─────
$output = $lines -join "`n"
Write-Output $output

if ($Save) {
    $output | Out-File -Encoding UTF8 -FilePath $Save
    Write-Host ""
    Write-Host "Report saved to: $Save" -ForegroundColor Green
}

# Exit code for CI / automation
if ($fail -gt 0) { exit 1 } else { exit 0 }
