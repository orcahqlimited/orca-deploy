# orca-deploy runbooks

Operational runbooks for ORCA installs. Public so customer-side Claude instances can `curl` them directly during install windows.

## Documents

- **[ORCAHQ-AI-ASSISTED-CUSTOMER-OPS-001.md](./ORCAHQ-AI-ASSISTED-CUSTOMER-OPS-001.md)** — the meta-pattern. How ORCA HQ runs customer-impacting changes when both sides have a Claude Code instance available. Read this once to understand the model.

- **[ORCAHQ-AC-CLAUDE-REDEPLOY-001.md](./ORCAHQ-AC-CLAUDE-REDEPLOY-001.md)** — first instance: AgileCadence redeploy from v0.2.4. Self-contained playbook the customer's Claude executes phase-by-phase. Templated for re-use with future customers — substitute the customer slug and the per-customer inputs section.

## How to use these in a customer Claude Code session

```bash
# In the customer's WSL/macOS workstation, after they have Claude Code installed
# and a fresh session open:

curl -fsSL https://raw.githubusercontent.com/orcahqlimited/orca-deploy/main/runbooks/ORCAHQ-AI-ASSISTED-CUSTOMER-OPS-001.md \
  > ~/orca-meta-playbook.md
curl -fsSL https://raw.githubusercontent.com/orcahqlimited/orca-deploy/main/runbooks/ORCAHQ-AC-CLAUDE-REDEPLOY-001.md \
  > ~/orca-customer-runbook.md

# Then in the Claude Code session:
#   "Read ~/orca-meta-playbook.md and ~/orca-customer-runbook.md.
#    You are the Customer Claude in this protocol. The ORCA HQ Founder
#    will be your operator's HQ contact. Begin Phase 1."
```

The customer's Claude treats the runbook as its instruction set. It does NOT execute Phase 0 (that's HQ's responsibility). It does Phases 1, 3, 4 directly and supervises the operator through Phase 2.

## Versioning

These documents are versioned in this repo's git history. Each runbook has a "v0.0.x" trailer; bump the trailer when reality changes the runbook (post-customer-run learnings, new failure modes, schema updates).

The HQ-internal canonical copies live in `orca-hq-config-repo/docs/runbooks/` and are kept in sync with this directory. If the two diverge, the public version wins (because that's what customers actually read).
