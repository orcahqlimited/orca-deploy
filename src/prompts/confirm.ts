import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { DeployContext } from '../types.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

// INTENT-ORCAHQ-104 §104-P — Deployment Plan confirm panel.
//
// Before this intent the panel listed ~8 resources but glossed over ~12 that
// were actually provisioned (SQL, PII vault, KEK, storage, Graph roles,
// Foundry proxy token, license child tokens, AKS + Qdrant, etc.). Customers
// reported back "you created more than you told me you would" which is a
// trust problem in a first-time install (CL-ORCAHQ-0119, 0121).
//
// This version enumerates every resource the installer will provision,
// grouped by phase, so the confirm gate matches what actually happens.

function line(text: string, dim = false): void {
  console.log(dim ? chalk.dim(text) : text);
}

export async function confirmDeployment(ctx: DeployContext): Promise<boolean> {
  log.heading('  Deployment Plan');
  log.divider();

  // Identity + scope
  console.log(`  Tenant:       ${chalk.white(ctx.tenantName)} ${chalk.dim(`(${ctx.tenantId})`)}`);
  console.log(`  Subscription: ${chalk.white(ctx.subscriptionName)} ${chalk.dim(`(${ctx.subscriptionId})`)}`);
  console.log(`  Customer:     ${chalk.white(ctx.customerSlug)}`);
  console.log(`  Region:       ${chalk.white(ctx.region)}`);
  if (ctx.customGatewayDomain) {
    console.log(`  Gateway host: ${chalk.white(ctx.customGatewayDomain)} ${chalk.dim('(custom — DNS required)')}`);
  }
  console.log(`  Connectors:   ${chalk.white(ctx.selectedConnectors.map(c => c.name).join(', '))}`);
  console.log(`  AI models:    ${chalk.white('Shared ORCA HQ Foundry, tokenised at gateway')} ${chalk.dim('(foundry.orcahq.ai, no HQ key in customer KV)')}`);
  log.blank();

  // Phase 1 — foundations
  line('  Phase 1 — Foundations', false);
  line(`    • Resource Group:  ${naming.resourceGroup(ctx.customerSlug, ctx.region)}`);
  line(`    • ACR:             ${naming.acrName(ctx.customerSlug, ctx.region)}`);
  line(`    • Key Vault:       ${naming.keyVaultName(ctx.customerSlug, ctx.region)} (RBAC mode, 90-day soft delete)`);
  line(`    • Managed Identity:${naming.managedIdentityName(ctx.customerSlug)}`);
  log.blank();

  // Phase 2 — data + encryption
  line('  Phase 2 — Data stores & envelope encryption', false);
  line(`    • Azure SQL:       ${naming.sqlServerName(ctx.customerSlug, ctx.region)} + ${naming.SQL_PII_VAULT_DB} (Basic)`);
  line(`    • Storage account: ${naming.storageAccountName(ctx.customerSlug, ctx.region)} / ${naming.ENCRYPTED_BRAIN_CONTAINER}`);
  line(`    • KEK in KV:       ${naming.ORCA_KEK_KEY_NAME} (RSA-2048, wrap/unwrap bound to gateway MI)`);
  line(`    • PII key in KV:   ${naming.PII_ENCRYPTION_KEY_SECRET} (AES-256, never regenerated)`);
  log.blank();

  // Phase 3 — identity
  line('  Phase 3 — Entra identity', false);
  line(`    • App registration: ORCA Intelligence Connectors (5 app roles)`);
  line('    • Deployer assigned to ORCA.Founder via Graph appRoleAssignedTo');
  line('    • Graph permissions for meeting capture (admin-consent required)');
  line('    • Claude.ai MCP callback registered on spa.redirectUris');
  log.blank();

  // Phase 4 — licensing + AI
  line('  Phase 4 — Licensing & AI model access', false);
  line('    • orca-license-master verified + written to KV (3-part JWT check)');
  line(`    • ${ctx.selectedConnectors.length} child licence(s) issued by license.orcahq.ai (offline fallback warns loudly)`);
  line('    • foundry-customer-token issued by license.orcahq.ai; gateway calls foundry.orcahq.ai');
  log.blank();

  // Phase 5 — workload
  line('  Phase 5 — Workload', false);
  line(`    • VNet + cae-infra subnet: ${naming.vnetName(ctx.customerSlug, ctx.region)}`);
  line(`    • Container Apps Env:      ${naming.caEnvironmentName(ctx.customerSlug, ctx.region)} (VNet-integrated)`);
  line('    • AKS cluster + Qdrant (single-node managed-disk, hourly snapshots)');
  for (const c of ctx.selectedConnectors) {
    line(`    • Container App:           ${naming.connectorAppName(c.slug)}`);
  }
  line(`    • Container App:           ${naming.gatewayAppName(ctx.customerSlug)} (MCP)`);
  line(`    • Container App:           ${naming.copilotAppName(ctx.customerSlug)} (ORCA Guardian)`);
  line(`    • Container App:           ${naming.governancePortalAppName(ctx.customerSlug)}`);
  line(`    • Container App:           ${naming.governanceConnectorAppName(ctx.customerSlug)}`);
  line(`    • Container App:           ${naming.licenseServiceAppName(ctx.customerSlug)}`);
  log.blank();

  // Phase 6 — verification
  line('  Phase 6 — Verification', false);
  line('    • Health checks on every Container App');
  line('    • Post-install estate report (install.complete fires only on clean exit)');
  log.divider();

  return confirm({ message: 'Proceed with deployment?', default: true });
}
