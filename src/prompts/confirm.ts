import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { DeployContext } from '../types.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function confirmDeployment(ctx: DeployContext): Promise<boolean> {
  log.heading('  Deployment Plan');
  log.divider();
  console.log(`  Tenant:       ${chalk.white(ctx.tenantName)} ${chalk.dim(`(${ctx.tenantId})`)}`);
  console.log(`  Subscription: ${chalk.white(ctx.subscriptionName)} ${chalk.dim(`(${ctx.subscriptionId})`)}`);
  console.log(`  Customer:     ${chalk.white(ctx.customerSlug)}`);
  console.log(`  Region:       ${chalk.white(ctx.region)}`);
  console.log(`  Connectors:   ${chalk.white(ctx.selectedConnectors.map(c => c.name).join(', '))}`);
  log.blank();
  console.log(chalk.dim('  Resources to create:'));
  console.log(`    ${naming.resourceGroup(ctx.customerSlug, ctx.region)}`);
  console.log(`    ${naming.acrName(ctx.customerSlug, ctx.region)} ${chalk.dim('(ACR)')}`);
  console.log(`    ${naming.keyVaultName(ctx.customerSlug, ctx.region)} ${chalk.dim('(Key Vault)')}`);
  console.log(`    ${naming.managedIdentityName(ctx.customerSlug)} ${chalk.dim('(Managed Identity)')}`);
  console.log(`    ORCA Intelligence Connectors ${chalk.dim('(Entra App, 5 roles)')}`);
  console.log(`    ${naming.caEnvironmentName(ctx.customerSlug, ctx.region)} ${chalk.dim('(Container Apps Env)')}`);
  for (const c of ctx.selectedConnectors) {
    console.log(`    ${naming.connectorAppName(c.slug)} ${chalk.dim('(Container App)')}`);
  }
  log.divider();

  return confirm({ message: 'Proceed with deployment?', default: true });
}
