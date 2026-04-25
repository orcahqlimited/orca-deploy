# ORCAHQ-AI-ASSISTED-CUSTOMER-OPS-001 — Gold-standard AI-assisted customer operations

**Status:** Active
**Authored:** 2026-04-25
**First instance:** AgileCadence v0.2.4 redeploy, Sunday 2026-04-26 (`ORCAHQ-AC-CLAUDE-REDEPLOY-001`)
**Audience:** ORCA HQ Founder, future ORCA HQ operations team, both sides of the Claude pair

---

## What this document is

The pattern ORCA HQ uses to run customer-impacting changes (installs, upgrades, migrations) when both ORCA HQ and the customer have a Claude Code instance available. It treats the two Claudes as collaborating peers with distinct visibility, with the operator as the only mutator and the only message-passer between them.

Per-customer runbooks (e.g. `ORCAHQ-AC-CLAUDE-REDEPLOY-001`) are *instances* of this pattern. This document is the abstract.

---

## Why this exists

ORCA HQ has tenant-level visibility of itself but not of the customer. The customer's Claude has visibility we don't. A redeploy that affects both sides — customer install pulling HQ-published images, calling HQ-hosted services — has surprise modes we can't see from one side alone:

- **Customer-only surprises**: existing KV secrets we forgot the installer would overwrite; MI role assignments that lapsed; pre-existing private endpoint that conflicts with the new install.
- **HQ-only surprises**: rc-1.0.0 retagged to a commit with an HQ-only assumption; license-service signing-key drift; a Cloudflare Worker upstream pointing at a stale FQDN.
- **Either-side-but-only-the-other-can-see**: TLS cert renewal in the customer's domain DNS that mismatches what HQ's licence-service expects.

Single-side runs catch some of these post-hoc when something breaks. AI-assisted two-side runs catch them at the boundary, during the planning phase, before any mutation happens.

The cost is process — not work. Every step is something we'd have done anyway; the value is in *capturing* it as a paste-able artefact and *forwarding* it across the boundary.

---

## Core principles

1. **The operator is the only mutator.** Neither Claude runs `az` commands that change Azure state. The operator types every install command. The Claudes capture, diagnose, and report. This is not a limitation — it's the safety property that makes the rest of the protocol trustworthy.

2. **Every phase produces an artefact.** No verbal summaries. Every phase boundary produces a markdown block, a file path, or a captured terminal output. Artefacts are the substrate the two Claudes pass between.

3. **Stop gates over speed.** A 60-second pause to forward a Plan panel to HQ catches the kind of bug that costs a week to recover from. Run on the slow path until you have evidence the fast path is safe.

4. **Capture, don't paraphrase.** When AC Claude reports terminal output back, paste it verbatim. When HQ Claude reports a finding, name the file path or commit SHA. Paraphrase is where errors hide.

5. **Reversibility costs are paid up front.** Before any mutating step, both Claudes have answered "if this fails halfway, what does rollback look like?" If the answer is "we don't know," the step doesn't run yet.

6. **Knowledge capture is part of the run, not after it.** Every surprise becomes a CL- entry, every changed assumption becomes an INTENT update, every new pattern becomes a brain entry. The run is incomplete until that's done.

---

## The four roles

### A. ORCA HQ Claude (this Claude)
- Lives at: HQ Founder workstation.
- Visibility: HQ Azure tenant, ACR contents, license-service logs, gateway telemetry stream, Cloudflare Worker config, all `orca-*` repos, infra/bicep, INTENT documents, this runbook.
- Cannot see: customer tenant, customer KV, customer SQL, customer Container Apps.
- Role: pre-flight HQ-side state, build/retag/publish images, watch HQ telemetry during install, diagnose HQ-side anomalies, capture knowledge.

### B. Customer Claude (e.g. AC Claude)
- Lives at: customer's workstation, inside their Azure tenant context.
- Visibility: customer tenant, customer KV (secret names + timestamps, never values), customer Container Apps, customer SQL, customer estate report.
- Cannot see: HQ tenant, ACR internals, license-service logs, INTENT documents.
- Role: pre-state capture inside customer tenant, supervise installer execution, post-state verification, structured report back to HQ.

### C. The operator (human)
- The only mutator. Types every command, answers every prompt, opens every browser device-code window.
- Lives at: customer's workstation (same workstation as customer Claude).
- Role: forward markdown blocks between Claudes via email or chat, type Y/n on the installer's confirm panels, hold the licence key + ACR token, paste raw terminal output back to either Claude on request.

### D. The runbook
- The shared truth between A, B, C.
- Versioned in `orca-hq-config-repo/docs/runbooks/` (HQ-readable) AND linkable from the public `orca-deploy` repo (customer-readable).
- Updated after every run with the learnings from that run.

---

## The five phases

Each phase has: who acts, what they produce, what blocks the next phase.

### Phase 0 — HQ pre-flight alignment (HQ Founder + HQ Claude)

**Goal:** HQ-side is in the exact shape the customer-side expects to call.

**Checks (informational):**
- 5-endpoint live health curl on `*.orcahq.ai` (license/telemetry/support-api/gateway/foundry).
- Bicep `what-if` against `infra/bicep/main.bicep` — review drift, do NOT auto-apply if drift exists.
- ACR tag audit: confirm `rc-1.0.0` for every customer-pulled image points at the intended commit (cross-reference against the source repo's commit history). Document the resolved digest.
- License-service signing key: live JWKS modulus matches the embedded PEM in the installer release tarball.
- Cloudflare Worker upstream map: every `*.orcahq.ai` hostname forwards to the current Azure Container App FQDN.

**Mutations (only if needed):**
- Re-tag `rc-1.0.0` if it points at a commit with a customer-breaking change (use `az acr import --force`).
- Cloudflare Worker redeploy if upstream FQDN changed.

**Blocks Phase 1:** any non-OK on the 5-endpoint health check.

**Artefact:** "HQ pre-flight report" — a markdown block listing each check + result + the resolved rc-1.0.0 digest. Forwarded to the operator.

### Phase 1 — Customer pre-state capture (Customer Claude)

**Goal:** complete record of customer estate before any change.

**Checks:**
- Confirm Azure context (tenant + sub).
- Capture current image tags for all 5 core-product Container Apps.
- Run `orca-estate-report.ps1` — full read-only inventory.
- KV secret names + timestamps (never values).
- MI role assignments.
- Current gateway `/health`.

**Mutations:** none.

**Blocks Phase 2:** any non-OK in the estate report that is unrelated to the planned change. (Pre-existing problems get resolved or explicitly waived BEFORE the install.)

**Artefacts:**
- `/tmp/orca-estate-pre.md` (estate report)
- `/tmp/orca-kv-secrets-pre.txt` (KV name list)
- `/tmp/orca-mi-roles-pre.txt` (role assignments)
- Image-tag block (5 tags + Founder-readable summary)

All four forwarded to the operator → HQ.

### Phase 2 — Install plan review (Customer Claude + Operator + HQ Claude)

**Goal:** what the installer says it will do, side-by-side with what we already have.

**Checks:**
- Bootstrap installer + run `node dist/index.js`.
- Operator answers prompts.
- Installer prints the **§104-P Deployment Plan panel** — capture verbatim.
- Operator forwards the Plan to HQ.
- HQ Claude diffs Plan against estate-pre, surfaces every line that:
  - Names a resource not in estate-pre (= will be CREATED — should be expected)
  - Names a resource in estate-pre but the Plan doesn't (= will be UNTOUCHED — usually fine)
  - Implies a property change not visible in the Plan (escalation to HQ judgement)
- HQ Claude returns: `proceed | hold | rollback`.

**Mutations:** none yet — the Plan panel is pre-confirmation.

**Blocks Phase 3:** the operator does not type Y until HQ returns `proceed`.

**Artefacts:**
- The Plan panel verbatim.
- HQ's diff verdict (proceed/hold/rollback + reasoning).

### Phase 3 — Install execution (Operator + Customer Claude + HQ Claude)

**Goal:** the install actually runs, observed from both sides.

**Customer side (operator + Customer Claude):**
- Operator types Y on the Plan panel.
- Customer Claude watches stdout for `ERROR:`, `FAIL`, `Cannot find`, `unauthorized`, captures any line that matches.
- Operator captures the installer's final summary table verbatim.

**HQ side (HQ Founder + HQ Claude):**
- Tails `license.orcahq.ai` install-event ingestion (`/api/install-event` LAW query — the new install fires one event).
- Tails `gateway.orcahq.ai` /alert (the agent-drift comparator should NOT fire — if it does, install caused unexpected drift).
- Tails `foundry.orcahq.ai` access logs for the new customer's first JWT-authed embedding call.

**Mutations:** the install itself.

**Blocks Phase 4:** any error captured in installer stdout.

**Artefacts:**
- Installer final summary (verbatim).
- HQ-side observed events (LAW query results, alert log).

### Phase 4 — Customer post-state verification (Customer Claude)

**Goal:** what's actually true after the install matches what was expected.

**Checks:**
- Re-run `orca-estate-report.ps1` → `/tmp/orca-estate-post.md`.
- Diff against `/tmp/orca-estate-pre.md` → `/tmp/orca-estate-diff.txt`.
- Gateway `/health` → 200.
- `/mcp` returns 401 (not licence error).
- `foundry-customer-token` exists in KV with recent `updated` timestamp.
- `FOUNDRY_ENDPOINT` env var on gateway = `https://foundry.orcahq.ai`.
- SQL ELOGIN check (load-bearing for the rc-1.0.0 pin discipline).

**Mutations:** none.

**Blocks Phase 5:** any check failing.

**Artefacts:** the report template at the end of the per-customer runbook.

### Phase 5 — Joint review + knowledge capture (HQ Claude + HQ Founder)

**Goal:** the run is permanently documented, learnings captured, follow-ups filed.

**Checks:**
- HQ Founder reviews the Phase 4 report.
- HQ Claude diffs HQ-side observed events against expected (e.g. did install-event arrive? did first JWT-authed Foundry call succeed?).
- Anything surprising → CL- entry in `orca-hq-config-repo/CLAUDE.md`.
- Any assumption changed → INTENT document update.
- Any new pattern → brain entry via `orca-store`.
- Per-customer runbook updated with learnings for next time.

**Mutations:** documentation only.

**Closes:** the run.

---

## Coordination protocol — how the two Claudes talk

The operator is the bridge. The protocol is:

1. **Each Claude posts artefacts as labelled markdown blocks** with explicit headers like `=== AC PHASE 1 PRE-STATE ===` and `=== END AC PHASE 1 PRE-STATE ===`.
2. **The operator copies the block** from one Claude's terminal and pastes it into the other Claude as a tagged user message: "From AC Claude: [paste]".
3. **Each Claude responds with a single labelled artefact block** — no preamble, no interactive back-and-forth. If a Claude needs more info, it says so in a single message and the operator goes back to the other Claude for it.
4. **The operator never paraphrases.** Either copy-paste verbatim, or capture a screenshot and paste the screenshot.

This sounds bureaucratic. It is. It also means the two Claudes' contributions are auditable, rerunnable, and survivable across context resets. After the run, the labelled blocks become the run record.

---

## The "HQ live-watch" companion

While the operator + Customer Claude run Phases 1–4, HQ Claude (this Claude) runs a live-watch loop on the HQ Founder workstation:

```bash
# Tail HQ-side install events from the LAW.
# (Adjust workspace + table to whatever 107-A is using.)
WS=$(az monitor log-analytics workspace show -g rg-orcahq-uks -n orca-license-logs --query customerId -o tsv)

# Run on a 30-second poll throughout the install window.
while true; do
  az monitor log-analytics query --workspace $WS \
    --analytics-query "AppTraces | where TimeGenerated > ago(2m) \
      | where Properties.event in ('install_event','foundry_token_issued','agent_security_checkin','license_verify_fail') \
      | project TimeGenerated, Properties" \
    -o tsv 2>/dev/null
  sleep 30
done
```

HQ Claude interprets each event as it arrives:
- `install_event` → expected, log to the run record.
- `foundry_token_issued` → expected for new install, log.
- `license_verify_fail` → unexpected, INVESTIGATE — could mean PEM mismatch in the deployed image.
- `agent_security_checkin` drift → unexpected coincidence, investigate but don't block install.
- Any other Founder-paging /alert event → HOLD the install via the operator, diagnose first.

---

## Reversibility — what failure looks like at each phase

| Phase | Failure mode | Recovery |
|---|---|---|
| 0 | HQ /health 5xx | Fix HQ first (gateway revision rollback, Worker rollback). Don't proceed. |
| 0 | rc-1.0.0 points at the wrong commit | `az acr import --force` to retag. 30 seconds. |
| 1 | Pre-existing customer estate problem | Resolve out-of-band before Phase 2 — usually a manual KV secret repair or MI role re-grant. |
| 2 | Plan panel shows unexpected resource creation | Operator types `n` to abort. Restart with corrected inputs. Nothing was provisioned. |
| 3 | Installer fails midway | The installer is idempotent. Operator re-runs `node dist/index.js`. Most resources check-then-update. |
| 3 | Telemetry shows `license_verify_fail` from the customer's just-deployed gateway | rc-1.0.0 was retagged to a wrong commit during Phase 0. Re-tag at HQ, ask customer to restart their gateway: `az containerapp revision restart` (operator does this, not HQ Claude). |
| 4 | SQL ELOGIN | This is the rc-1.0.0 pin discipline failing — gateway image has `1b09acd` but customer SQL DB has no MI user. Retag rc-1.0.0 to `5de7b4b`, restart customer gateway, re-verify. |
| 5 | Surprise that doesn't fit any known pattern | Block the next customer install. Reproduce in NONPROD if possible. CL- entry. Don't proceed to next customer until pattern is understood. |

---

## Pre-requisites that must exist for the gold standard to work

A run is gold-standard when ALL of the below are true:

| Pre-req | Owner | Verifiable how |
|---|---|---|
| HQ Bicep `what-if` is "= Unchanged" only (no drift) | HQ | Run `az deployment sub what-if` and read the count line |
| `rc-1.0.0` pinned to known-good digests for all 5 customer images | HQ | `az acr manifest show-metadata` (or import-self check) |
| Workforce prompts (Ellis/Lisa) deployed and producing structured checkins | HQ | `orca-find` for `OBS-SECURITY-CHECKIN-YYYY-MM-DD` from Ellis, dated today |
| agent-drift comparator running and clean (or expected stale) | HQ | `orca-agent-drift` Container App Job execution log shows recent success |
| Customer Claude has the per-customer runbook URL + this meta-runbook URL | Customer ops | Operator confirms Customer Claude has read both |
| HQ Claude has live-watch script ready, LAW queryable, /alert webhook reachable | HQ | Test query against LAW + dummy /alert from HQ workstation |
| The 5 `*.orcahq.ai` hostnames live + healthy | HQ | 5-endpoint curl |
| The licence key + ACR deploy token for this customer are in HQ's Key Vault under their slug | HQ | `az keyvault secret list` filter for slug |
| Reversibility runbook (this section) reviewed by both Claudes | HQ + Customer | Operator confirms both Claudes acknowledge the rollback paths |

The set of currently-not-true pre-reqs is the **Sunday pre-flight checklist**. See `ORCAHQ-AC-CLAUDE-REDEPLOY-001` for the AC-specific incarnation.

---

## What "gold standard" specifically means here

Not: "exhaustive automation".
Not: "no human in the loop".
Not: "multiple Claudes running unattended overnight".

Yes: every customer-impacting change has both sides observing, every phase produces an artefact, every surprise is captured before the next phase, every change is reversible, and every run improves the next run by feeding back into this document.

The first instance of this pattern (AgileCadence Sunday redeploy) is also the alignment event — running it forces every loose end (Bicep drift, prompt validation, agent-drift validation, knowledge capture) into a clean state by the time we declare the run complete. We knowingly use the customer install as the forcing function for HQ alignment, because the alternative — wait until everything is perfect before any customer touches anything — is how customer #2 never ships.

---

## Document map

| Document | Role |
|---|---|
| This file (`ORCAHQ-AI-ASSISTED-CUSTOMER-OPS-001`) | Pattern (abstract) |
| `ORCAHQ-AC-CLAUDE-REDEPLOY-001` | First instance (AgileCadence) |
| `ORCAHQ-AGILE-DAY1-FIXUP` | Predecessor — manual fix-up runbook from the original AC install (case-law) |
| `INTENT-ORCAHQ-104` | What the v0.2.4 installer changed |
| `INTENT-ORCAHQ-107` | Telemetry track A (what HQ sees during install) |
| `INTENT-ORCAHQ-108` | Network hardening that drove the rc-1.0.0 pin discipline |
| `CL-ORCAHQ-0142` | Why the agent-drift comparator exists |
| `infra/bicep/` | HQ IaC — currently drifted, TASK-105 to reconcile |

---

## v0.0.1 — change log

**2026-04-25**: First version, authored ahead of AC Sunday redeploy. Codifies the two-Claude pattern + operator-as-bridge protocol + the five-phase structure. Will be revised after the AC run with learnings.
