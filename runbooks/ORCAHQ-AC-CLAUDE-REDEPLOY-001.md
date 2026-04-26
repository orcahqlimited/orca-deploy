# ORCAHQ-AC-CLAUDE-REDEPLOY-001 — AgileCadence redeploy via AC Claude

**Status:** Active
**Audience:** AC's Claude Code instance, supervised by the AgileCadence operator (or, on this run, the ORCA HQ Founder)
**Date authored:** 2026-04-25
**Target run window:** Sunday 2026-04-26 evening
**Target installer version:** orca-installer v0.2.4 (orca-deploy tag `v0.2.4`)

---

## Why this runbook exists

The AgileCadence (AC) tenant has its own Claude Code instance. AC's Claude has tenant-level visibility (Key Vault secrets list, Container App image digests, MI role assignments, SQL state) that ORCA HQ does not. Running the v0.2.4 redeploy from inside AC's Claude:

- Captures a complete pre-install state report we can diff against post-install (instead of guessing).
- Removes manual-CLI error from a human typing.
- Produces a structured, auditable report HQ reviews end-of-run.

This runbook is the full briefing for AC's Claude. Paste it (or fetch it) into a fresh Claude Code session in AC's tenant. The runbook is self-contained — no other ORCA HQ document is required.

---

## What you (AC Claude) will do

Three phases, in strict order. Stop and report back to HQ on the first non-OK finding in any phase — do not auto-correct.

1. **Pre-install diagnostics** — read-only state capture of the AgileCadence ORCA estate.
2. **Install** — fetch and run the v0.2.4 installer from the public orca-deploy repo.
3. **Post-install verification** — health checks, FQDN reachability, licence + foundry path proven.

Then post a single Markdown report back to the operator (the operator forwards to HQ).

---

## Boundary conditions (read these first)

- Do NOT modify Azure resources outside what the installer mutates. No "while we're here" cleanups.
- Do NOT push any changes to GitHub from AC's environment. You are a consumer of orca-deploy, not a contributor.
- Do NOT exfiltrate Key Vault secret VALUES — only secret NAMES + last-modified timestamps.
- The installer will run device-code Azure sign-in inline; the operator handles the device-code prompt. Don't try to script around it.
- If any check produces output you don't recognise, paste the raw output verbatim into the report instead of paraphrasing.
- Never use `--no-verify`, `--force`, or any other override unless this runbook explicitly says to. The installer is idempotent (CL-ORCAHQ-0104) and re-running it is safe.

---

## Inputs the operator will provide

Before you start, confirm with the operator that you have:

| Input | Example | Where it comes from |
|---|---|---|
| `CUSTOMER_SLUG` | `agile` | Already set in AC's tenant — read from existing resource names (`rg-orca-agile-uks` confirms it) |
| `REGION` | `uksouth` | Same — read from RG location |
| `LICENCE_KEY` | a JWT string | The operator has this from their HQ contact (you do not) |
| `ACR_DEPLOY_TOKEN` | a token string | Same — operator has this |

If the slug or region is ambiguous, STOP and ask the operator. Do not guess.

---

## Phase 0 — HQ-side drift check (HQ Founder, NOT AC Claude)

Before AC starts Phase 1, ORCA HQ confirms HQ-side infrastructure is in the expected shape. AC's gateway calls HQ services (license, telemetry, support-api, foundry, gateway) — anything broken on the HQ side surfaces as a mystery on the customer side.

> **Note for 2026-04-26 run:** The `hq-live-watch.sh` script queries `orca-license-logs` AppTraces. That table is **empty** — Track A telemetry ingest is half-broken (license-service Table Storage write fails on every batch with EDM type error; LAW write env vars never wired). **Do not rely on hq-live-watch tonight.** Tail the license-service console directly instead: `az containerapp logs show -g rg-orcahq-uks -n orca-license-service-v --follow` — `[telemetry] ingested` lines are where events actually appear. The AC operator's structured reports remain the primary observation channel. Track A repair tracked as TASK-110.

### 0.1 — Live HQ endpoint health (always do this)

```bash
for h in license.orcahq.ai telemetry.orcahq.ai support-api.orcahq.ai gateway.orcahq.ai foundry.orcahq.ai; do
  printf "%-25s " "$h"; curl -s -o /dev/null -w "%{http_code}\n" https://$h/health
done
```

All 5 should return 200 (foundry returns 200 for `/health` even though `/embed` calls require a JWT). If any are not 200, STOP and fix HQ before AC starts.

### 0.2 — Bicep what-if (informational only, 2026-04-25)

```bash
# From the orca-hq-config-repo working tree:
export FOUNDER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)
az deployment sub what-if \
  --location uksouth \
  --template-file infra/bicep/main.bicep \
  --parameters infra/bicep/main.bicepparam \
  --parameters founderObjectId=$FOUNDER_OBJECT_ID
```

**Known state as of 2026-04-25**: the Bicep templates are out of sync with reality. The 2026-04-25 run showed `6 create, 32 modify, 4 no change, 31 to ignore`. Notable drift:

- `orcahqlicensedata` storage: Bicep would flip `publicNetworkAccess Disabled → Enabled` (regressing INTENT-108 hardening). **Do NOT run `az deployment sub create`.**
- 31 newer resources are unmanaged by Bicep (private endpoints, private DNS zones, copilot, agent-drift job, copilot-insights, bot service, etc.) — added by direct `az` calls during INTENT-095 / 108 / 107.

This is tracked drift, not a Sunday blocker. The drift means we cannot use Bicep as the "expected state" oracle for HQ until reconciliation lands (TASK-105). Use the live endpoint health (0.1) + the orca-estate-report from AC's Phase 1 as the practical source of truth.

If 0.1 is green, proceed to Phase 1 even with 0.2 still drifted.

---

## Phase 1 — Pre-install diagnostics (AC Claude)

### Step 1.1 — Confirm Azure context

```bash
az account show --query "{name:name,tenantId:tenantId,id:id}" -o table
```

Expected: AgileCadence tenant + sub. If wrong tenant, STOP and ask the operator.

### Step 1.2 — Capture current installer + image versions

> **Naming note (v0.0.2):** workload Container Apps do **NOT** carry the customer slug — `naming.ts` returns hardcoded names (`orca-mcp-gateway`, `orca-copilot`, `orca-governance-portal`, `orca-governance-connector`, `orca-license-service`). Only the *infrastructure* tier (RG, KV, MI, ACR, CAE, SQL, AKS, Storage, VNet) is slug-prefixed. The installer UPDATEs workload apps in place — it does NOT create slug-named parallels alongside.

```bash
# What image is the customer-deployed gateway running RIGHT NOW?
az containerapp show \
  -g rg-orca-${CUSTOMER_SLUG}-uks \
  -n orca-mcp-gateway \
  --query "properties.template.containers[0].image" -o tsv

# Same for the other 4 core-product apps:
for app in license-service copilot governance-portal governance-connector; do
  echo "=== $app ==="
  az containerapp show \
    -g rg-orca-${CUSTOMER_SLUG}-uks \
    -n orca-${app} \
    --query "properties.template.containers[0].image" -o tsv 2>/dev/null \
    || echo "  (not deployed)"
done
```

Record each image tag verbatim. The new install will replace these — we want the diff.

### Step 1.3 — Run the orca estate report (full pre-install snapshot)

```bash
# The report script is bundled with the installer release tarball.
# Pull it directly from the public orca-deploy repo (latest tag).
curl -fsSL \
  https://raw.githubusercontent.com/orcahqlimited/orca-deploy/v0.2.4/scripts/orca-estate-report.ps1 \
  -o /tmp/orca-estate-report.ps1

# Run it. PowerShell is required (pwsh). The installer image ships pwsh + sqlcmd
# (CL-ORCAHQ-0115), so if the operator already has the installer tarball
# extracted from a previous run, pwsh is in $PATH.
pwsh /tmp/orca-estate-report.ps1 ${CUSTOMER_SLUG} ${REGION} -Save /tmp/orca-estate-pre.md
```

Save the resulting `/tmp/orca-estate-pre.md` for the report back to HQ. Do not edit it. It is the canonical pre-state record.

### Step 1.4 — Capture KV secret name list (no values)

```bash
az keyvault secret list \
  --vault-name kv-orca-${CUSTOMER_SLUG}-uks \
  --query "[].{name:name,updated:attributes.updated}" \
  -o table > /tmp/orca-kv-secrets-pre.txt
```

Names and timestamps only. The installer adds new secrets (e.g. `foundry-customer-token`) on a v0.2.4 redeploy — we want to confirm what's already there.

### Step 1.5 — Capture MI role assignments

```bash
MI_PRINCIPAL=$(az identity show \
  -g rg-orca-${CUSTOMER_SLUG}-uks \
  -n orca-${CUSTOMER_SLUG}-mi \
  --query principalId -o tsv)

az role assignment list \
  --assignee-object-id $MI_PRINCIPAL \
  --query "[].{role:roleDefinitionName,scope:scope}" \
  -o table > /tmp/orca-mi-roles-pre.txt
```

### Step 1.6 — Confirm gateway /health is currently green

```bash
GATEWAY_FQDN=$(az containerapp show \
  -g rg-orca-${CUSTOMER_SLUG}-uks \
  -n orca-mcp-gateway \
  --query "properties.configuration.ingress.fqdn" -o tsv)

curl -sw "\nstatus=%{http_code}\n" https://${GATEWAY_FQDN}/health
```

Expect HTTP 200. If not 200 already, FLAG IT in the report and ask the operator before continuing — a redeploy on a sick gateway can mask the original symptom.

### Phase 1 STOP gate

Pause. Send the operator the following four artefacts:

1. The current image tags from step 1.2.
2. `/tmp/orca-estate-pre.md` (full estate report).
3. `/tmp/orca-kv-secrets-pre.txt` (KV secret name list).
4. `/tmp/orca-mi-roles-pre.txt` (role assignments).

Wait for the operator's "proceed" before Phase 2. The operator will forward to HQ for a 60-second sanity check.

---

## Phase 2 — Install

### Step 2.1 — Fetch the v0.2.4 installer

The bootstrap script is the canonical entry point — it pulls the right tarball, installs CLI tools if missing, and prints the next command:

```bash
curl -fsSL https://raw.githubusercontent.com/orcahqlimited/orca-deploy/v0.2.4/bootstrap.sh | bash
```

Expected: completes with the "═══ Bootstrap complete ═══" banner and tells the operator to run two commands.

### Step 2.2 — Run the installer

```bash
docker run --rm -it \
  -v ~/.azure:/root/.azure \
  -e ORCA_LICENCE_KEY="<paste licence from operator out-of-band>" \
  ghcr.io/orcahqlimited/orca-installer:latest

# (the bundled `node dist/index.js` was deprecated in v0.2.4 §104-O — it's
# now just a sign-post stub that prints the docker command above. The
# container ships pwsh + sqlcmd + node + az + helm + kubectl preinstalled,
# so no host-side install dependencies. ~/.azure bind-mount shares the
# operator's WSL `az login` session into the container.)
```

The installer runs in interactive mode. The operator answers prompts:

| Prompt | Answer |
|---|---|
| Customer slug | `${CUSTOMER_SLUG}` (must match existing — type same value) |
| Azure region | `${REGION}` |
| Custom domain | whatever was used originally (estate report shows this) |
| Connectors | same as currently deployed (estate report shows this) |
| Licence key | from operator |
| ACR deploy token | from operator |
| Device-code sign-in | operator opens URL, enters code |

You (AC Claude) should NOT advance past prompts on the operator's behalf. Watch the output. If the installer prints any line containing `ERROR:`, `FAIL`, `Cannot find`, or `unauthorized`, STOP and capture the surrounding context.

### Step 2.2a — STOP at the Deployment Plan panel (load-bearing)

After the operator answers all prompts, the installer prints a **"Deployment Plan"** panel (INTENT-104 §104-P). It lists every resource the installer is about to provision, grouped by Phase 1–6. Example shape:

```
  Deployment Plan
  ────────────────────────────────────────────
  Tenant:       ...
  Subscription: ...
  Customer:     agile
  ...

  Phase 1 — Foundations
    • Resource Group:  rg-orca-agile-uks
    • ACR:             orcaagileacruks
    ...
  Phase 2 — Data stores & envelope encryption
    ...
  Phase 5 — Workload
    • Container App:   orca-agile-mcp-gateway (MCP)
    ...

  Proceed?  [Y/n]
```

**Do NOT type Y.** Instead:

1. Capture the entire Deployment Plan panel verbatim (copy from the operator's terminal).
2. Side-by-side compare it to `/tmp/orca-estate-pre.md` from Phase 1.3:
   - Every resource in the Plan should already exist in pre-state (this is a redeploy, not a new install).
   - If the Plan lists a resource that is NOT in pre-state, that's a NEW resource — flag it. The expected new ones are: `foundry-customer-token` (KV secret) and the `FOUNDRY_ENDPOINT` env var change. Anything else is a surprise.
   - If pre-state has a resource that is NOT in the Plan, that resource won't be touched — fine, but note it in the report.
3. Send the Plan + diff to the operator. The operator forwards to HQ.
4. Wait for "proceed" from the operator before typing Y.

This is the customer-side equivalent of `az deployment sub what-if`. The installer is imperative TypeScript, not Bicep, so there is no real `what-if` — but the §104-P panel + estate-report diff is the same pattern: *current state vs proposed state vs expected state*, before mutation.

### Step 2.3 — Capture the installer's final summary

The installer prints a summary table at the end with the deployed image tags, FQDNs, and any non-default decisions taken. Copy that summary verbatim into the report.

---

## Phase 3 — Post-install verification

### Step 3.1 — Re-run the estate report

```bash
pwsh /tmp/orca-estate-report.ps1 ${CUSTOMER_SLUG} ${REGION} -Save /tmp/orca-estate-post.md
```

Diff against `/tmp/orca-estate-pre.md`:

```bash
diff /tmp/orca-estate-pre.md /tmp/orca-estate-post.md > /tmp/orca-estate-diff.txt || true
```

Expected diffs (these are NORMAL):
- Image tags advance (e.g. `rc-1.0.0` digest changes — even if the tag string is the same, the underlying digest may differ). The five customer-facing tags should all still resolve to `rc-1.0.0`.
- `foundry-customer-token` appears in KV (new secret).
- `FOUNDRY_ENDPOINT` env var on the gateway flips from a direct Azure-region URL to `https://foundry.orcahq.ai`.
- App restart timestamps refresh.
- `[OK]` count increases (more checks pass than before).

Any other diff is suspicious. Quote it in the report.

### Step 3.2 — Gateway health

```bash
curl -sw "\nstatus=%{http_code}\n" https://${GATEWAY_FQDN}/health
```

Must be 200. If not, STOP and capture the response body.

### Step 3.3 — Licence verification path

```bash
# The gateway calls license.orcahq.ai on every /mcp request after the boot
# grace window (104-K). Simulate by hitting the gateway's /mcp endpoint
# WITHOUT auth — we expect 401, not 502 or licence error.
curl -sw "\nstatus=%{http_code}\n" https://${GATEWAY_FQDN}/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'
```

Expected: HTTP 401 with body containing `unauthorized` or `missing_bearer_token`. Anything mentioning `licence`, `JWKS`, or `verify` in the error path is a problem — capture it and STOP.

### Step 3.4 — Foundry proxy reachability

```bash
# Read the new foundry token (existence check — never log the value)
az keyvault secret show \
  --vault-name kv-orca-${CUSTOMER_SLUG}-uks \
  --name foundry-customer-token \
  --query "{name:name,enabled:attributes.enabled,updated:attributes.updated}" \
  -o json
```

Expected: enabled=true, updated within the last 30 minutes (i.e. the redeploy created or refreshed it).

```bash
# Confirm the gateway's FOUNDRY_ENDPOINT env var now points at orcahq.ai
az containerapp show \
  -g rg-orca-${CUSTOMER_SLUG}-uks \
  -n orca-mcp-gateway \
  --query "properties.template.containers[0].env[?name=='FOUNDRY_ENDPOINT'].value" \
  -o tsv
```

Expected: `https://foundry.orcahq.ai`.

### Step 3.5 — SQL access (load-bearing for PII tokenisation)

```bash
# Try a write-then-read of a non-sensitive token via the gateway's
# tokenisation endpoint. This is a real end-to-end test that the gateway
# can reach the customer's SQL DB.
curl -sw "\nstatus=%{http_code}\n" https://${GATEWAY_FQDN}/_internal/health/sql 2>/dev/null \
  || echo "(_internal/health/sql may not be exposed — alternative: tail logs for SQL ELOGIN)"

# Always also run this:
az containerapp logs show \
  -g rg-orca-${CUSTOMER_SLUG}-uks \
  -n orca-mcp-gateway \
  --type system --tail 100 \
  --format text 2>&1 | grep -iE 'ELOGIN|SQL|principal|access denied' | head -20
```

If any line contains `ELOGIN`, `Login failed`, `principal "[orca-...-mi]" does not exist`, or `cannot open database` — STOP. This means the deployed gateway image has commit `1b09acd` (Entra-only SQL) but the customer SQL DB has not had `CREATE USER FROM EXTERNAL PROVIDER` run for the gateway MI. The HQ team has explicitly pinned `rc-1.0.0` to a commit BEFORE 1b09acd to prevent this — if you see this error, the pin has been reverted at HQ-end and HQ needs to know IMMEDIATELY.

### Step 3.6 — Foundry-key sunset preflight (do NOT execute)

The orca-deploy repo includes `scripts/sunset-legacy-foundry-keys.sh`. **Do not run it during this redeploy.** It needs at least 7 days of successful foundry-proxy traffic before it can be safely executed. The operator (or HQ) runs it later, after monitoring confirms the proxy path is healthy.

---

## Report template

Post the following Markdown back to the operator (one block, paste-ready). The operator forwards to HQ.

```markdown
# AgileCadence redeploy report — <DATE_LOCAL>

**Installer version:** orca-installer v0.2.4 (orca-deploy tag v0.2.4)
**Run by:** AC Claude (this instance) under operator supervision
**Tenant:** AgileCadence
**Result:** <PROCEED | STOPPED | COMPLETED>

## Pre-install state

- Gateway image (before): `<tag>`
- License-service image (before): `<tag>`
- Copilot image (before): `<tag>`
- Governance-portal image (before): `<tag>`
- Governance-connector image (before): `<tag>`
- Estate report `[OK]/[WARN]/[FAIL]` counts (before): `<n/n/n>`
- Gateway `/health` (before): `<status>`

## Install summary (verbatim from installer)

```
<paste the installer's final summary table here>
```

## Post-install state

- Gateway image (after): `<tag>`
- License-service image (after): `<tag>`
- Copilot image (after): `<tag>`
- Governance-portal image (after): `<tag>`
- Governance-connector image (after): `<tag>`
- Estate report `[OK]/[WARN]/[FAIL]` counts (after): `<n/n/n>`
- Gateway `/health` (after): `<status>`

## Verification

- Step 3.2 gateway /health: `<status>`
- Step 3.3 /mcp returns 401 (not licence error): `<YES/NO + body if not>`
- Step 3.4 foundry-customer-token in KV: `<YES + updated_at | NO>`
- Step 3.4 FOUNDRY_ENDPOINT: `<value>`
- Step 3.5 SQL ELOGIN check: `<CLEAN | found: <line>>`

## Diff highlights (from /tmp/orca-estate-diff.txt)

```
<paste the most important 20 lines of the diff>
```

## Anomalies / open questions for HQ

<bulleted list — anything you don't understand, anything not on the
"expected diff" list above, anything that surprised you. Empty list = clean run.>

## Artefacts retained on the AC workstation

- `/tmp/orca-estate-pre.md`
- `/tmp/orca-estate-post.md`
- `/tmp/orca-estate-diff.txt`
- `/tmp/orca-kv-secrets-pre.txt`
- `/tmp/orca-mi-roles-pre.txt`

(Operator: keep these for 14 days then delete. They contain no secret values
but do contain resource topology that is sensitive.)
```

---

## What HQ will do with the report

- Diff post-state image tags against the pinned `rc-1.0.0` digest from the HQ ACR side.
- Confirm the `foundry-customer-token` was issued by HQ's `orca-license-service` (provenance check).
- Add an INTENT-107 telemetry verification: gateway should have emitted a `gateway-event-v1` to `telemetry.orcahq.ai` within 15 minutes of post-install boot.
- File any "Anomalies / open questions" as INTENT items or CL- entries as appropriate.

---

## Failure modes — what to do if X happens

| Symptom | Most likely cause | Action |
|---|---|---|
| Phase 1 step 1.6 gateway not 200 | Pre-existing outage | STOP. Operator decides whether to proceed (a redeploy may fix it) or call HQ first. |
| Phase 2 installer prompts for slug + region not matching existing | Operator typo | Cancel installer, restart, re-enter same values. |
| Phase 2 installer fails on Entra app reuse | Stale credential or consent state | Capture full output. STOP. HQ has runbook ORCAHQ-AGILE-DAY1-FIXUP for this class. |
| Phase 3.5 SQL ELOGIN | rc-1.0.0 has been bumped past commit 1b09acd at HQ-end without installer support | STOP IMMEDIATELY. Tell HQ. They will retag rc-1.0.0 back to 5de7b4b and you re-run Phase 2. |
| Phase 3.3 /mcp returns 5xx instead of 401 | Licence-service unreachable from customer gateway, or PEM mismatch | Capture body. Try `curl https://license.orcahq.ai/.well-known/jwks.json` from AC workstation — if that's also broken, HQ side is down. |
| Customer gateway is unhealthy after Phase 3 and we want to roll back to the prior revision | Install caused a regression we don't immediately understand | Operator runs (single-revision mode is on, so Container Apps swaps active revision atomically): `az containerapp revision list -g rg-orca-${CUSTOMER_SLUG}-uks -n orca-mcp-gateway --query "[].{name:name,active:properties.active,image:properties.template.containers[0].image,createdTime:properties.createdTime}" -o table` to see all revisions; identify the previous revision (one before the active one in `createdTime` order); then `az containerapp ingress traffic set -g rg-orca-${CUSTOMER_SLUG}-uks -n orca-mcp-gateway --revision-weight <previous-revision>=100 latest=0`. After traffic shift, retry `/health` — should return 200 within 60s. STOP further phases, write up the rollback in the report's "Anomalies" section. (Note: `revision deactivate` works if the app is in multiple-revision mode; the traffic-weight command works in either mode.) |
| Anything not in this table | Unknown — write it up in "Anomalies", do not improvise. | Report and wait. |

---

## Notes for the next iteration

This runbook is v0.0.1. After AC's first run we expect to learn:
- Which steps were ambiguous to AC's Claude.
- What additional pre-state we wished we'd captured.
- Whether the report template needs more or fewer fields.

Capture those learnings in a CL- entry and revise this document accordingly.
