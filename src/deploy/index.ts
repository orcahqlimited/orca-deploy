import type { DeployContext } from '../types.js';
import { createResourceGroup } from './resource-group.js';
import { createAcr } from './acr.js';
import { createKeyVault } from './keyvault.js';
import { createManagedIdentity } from './identity.js';
import { createEntraApp, updateEntraRedirectUris } from './entra.js';
import { createEnvironment } from './environment.js';
import { importImages } from './images.js';
import { createContainerApps } from './containers.js';
import { runHealthChecks, printSummary } from './health.js';
import { provisionLicenses } from './licenses.js';
import {
  createEligibilityGroup,
  addGraphPermissions,
  createGraphSubscription,
  grantApplicationAccessPolicy,
} from './rbac-graph.js';
import * as log from '../utils/log.js';
import chalk from 'chalk';

export async function deploy(ctx: DeployContext): Promise<void> {
  log.heading(`  Deploying to ${ctx.customerSlug} (${ctx.region})`);
  log.blank();

  try {
    // Step 1: Resource Group
    await createResourceGroup(ctx);

    // Step 2 & 3: ACR + Key Vault (could be parallel, but sequential for reliability)
    await createAcr(ctx);
    await createKeyVault(ctx);

    // Step 4: Managed Identity + RBAC
    await createManagedIdentity(ctx);

    // Step 5: Entra App Registration
    await createEntraApp(ctx);

    // Step 5a: Extend the ORCA Entra app with Graph permissions for meeting capture
    //          (idempotent; admin consent may require Global Admin — warns + continues)
    await addGraphPermissions(ctx);

    // Step 5b: Provision ORCA licences (after Key Vault, before containers)
    await provisionLicenses(ctx);

    // Step 5c: ORCA-Eligible Entra group (gates who receives a personal brain)
    await createEligibilityGroup(ctx);

    // Step 5e: Teams CsApplicationAccessPolicy (can run once the Entra app exists;
    //          PowerShell-dependent — prints manual fallback if pwsh is missing)
    await grantApplicationAccessPolicy(ctx);

    // Step 6: Container Apps Environment
    await createEnvironment(ctx);

    // Step 7: Import images from ORCA HQ ACR
    await importImages(ctx);

    // Step 8: Create Container Apps
    await createContainerApps(ctx);

    // Step 8b: Update Entra redirect URIs with connector callback URLs
    await updateEntraRedirectUris(ctx);

    // Step 8c: Graph subscription for transcript notifications.
    //          Requires the gateway to be deployed and ctx.gatewayUrl set. If it
    //          isn't (connector-only deploys), this step is skipped with a warn.
    await createGraphSubscription(ctx);

    // Step 9: Health checks
    log.blank();
    const healthy = await runHealthChecks(ctx);

    if (healthy) {
      printSummary(ctx);
    } else {
      log.blank();
      log.warn('Some health checks failed. Connectors may need a few minutes to start.');
      log.dim(`Check manually: curl https://{connector-fqdn}/health`);
      printSummary(ctx);
    }
  } catch (err: any) {
    log.blank();
    log.fail(chalk.red.bold(`Deployment failed: ${err.message}`));
    log.blank();
    if (ctx.resourceGroup) {
      log.dim(`To clean up: az group delete --name ${ctx.resourceGroup} --yes --no-wait`);
    }
    process.exit(1);
  }
}
