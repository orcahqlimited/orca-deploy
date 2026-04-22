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
import { verifyLicence, printLicenceSummary } from './licence/verify.js';
import * as log from './utils/log.js';

async function main(): Promise<void> {
  // 1. Banner
  showBanner();

  // 2. Azure Context — Tenant & Subscription
  const { tenantId, tenantName } = await selectTenant();
  const { subscriptionId, subscriptionName } = await selectSubscription(tenantId);

  // 2b. Licence gate — refuse to continue without a valid ORCA_LICENCE_KEY
  //     signed by ORCA HQ and bound to this tenant. No resources are created
  //     if the licence is missing, forged, expired, or bound to a different
  //     tenant. Errors printed clearly with remediation path.
  let licence;
  try {
    licence = await verifyLicence();
    printLicenceSummary(licence);
  } catch (err: any) {
    log.blank();
    log.fail(err.message);
    process.exit(2);
  }

  // 3. Customer & Region — if the licence carries a customer slug, default to
  //    it (customer can still override at the prompt, but the typical flow is
  //    to accept what the licence says).
  const { customerSlug, region, regionShort, customGatewayDomain } = await getCustomerAndRegion();

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
    customGatewayDomain,
    // Licence payload — the raw JWT is written to KV as the master licence
    // by provisionLicenses, replacing the previous in-flight-issue flow.
    licenceToken: licence.token,
    licenceClaims: licence.claims,
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
    mask: '*',
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
