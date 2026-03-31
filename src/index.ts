#!/usr/bin/env node

import { password } from '@inquirer/prompts';
import type { DeployContext } from './types.js';
import { showBanner } from './banner.js';
import { showComingSoon } from './coming-soon.js';
import { selectTenant, selectSubscription } from './prompts/azure-context.js';
import { getCustomerAndRegion } from './prompts/welcome.js';
import { selectConnectors } from './prompts/connectors.js';
import { collectCredentials } from './prompts/credentials.js';
import { confirmDeployment } from './prompts/confirm.js';
import { runPreflight } from './preflight/index.js';
import { deploy } from './deploy/index.js';
import * as log from './utils/log.js';

async function main(): Promise<void> {
  // 1. Banner
  showBanner();

  // 2. Azure Context — Tenant & Subscription
  const { tenantId, tenantName } = await selectTenant();
  const { subscriptionId, subscriptionName } = await selectSubscription(tenantId);

  // 3. Customer & Region
  const { customerSlug, region, regionShort } = await getCustomerAndRegion();

  // 4. Connector Selection
  const selectedConnectors = await selectConnectors();

  // 5. Coming Soon
  showComingSoon();

  // Build initial context
  const ctx: DeployContext = {
    tenantId,
    tenantName,
    subscriptionId,
    subscriptionName,
    customerSlug,
    region,
    regionShort,
    selectedConnectors,
    credentials: {},
    connectorFqdns: {},
    licenseTokens: {},
  };

  // 6. Pre-flight Checks
  const preflightPassed = await runPreflight(ctx);
  if (!preflightPassed) {
    process.exit(1);
  }

  // 7. Credential Prompts
  ctx.credentials = await collectCredentials(selectedConnectors);

  // 8. ORCA HQ ACR Token (for importing images)
  log.heading('  ORCA HQ Image Library');
  log.dim('An ORCA HQ deployment token is required to import connector images.');
  log.dim('This token is provided by ORCA HQ and has read-only access to RC images.');
  ctx.orcaAcrToken = await password({
    message: 'ORCA HQ ACR deployment token:',
  });

  // 9. Confirm
  const confirmed = await confirmDeployment(ctx);
  if (!confirmed) {
    log.info('Deployment cancelled.');
    process.exit(0);
  }

  // 10. Deploy
  await deploy(ctx);
}

main().catch((err) => {
  log.fail(`Fatal error: ${err.message}`);
  process.exit(1);
});
