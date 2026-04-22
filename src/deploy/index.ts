import type { DeployContext } from '../types.js';
import { createResourceGroup } from './resource-group.js';
import { createAcr } from './acr.js';
import { createKeyVault } from './keyvault.js';
import { createManagedIdentity } from './identity.js';
import { createEntraApp, updateEntraRedirectUris } from './entra.js';
import { createVnet } from './vnet.js';
import { createEnvironment } from './environment.js';
import { importImages, importCoreProductImages } from './images.js';
import { createContainerApps } from './containers.js';
import { deployCoreProduct } from './core-product.js';
import { deployAksQdrant } from './aks-qdrant.js';
import { bindCustomGatewayDomain } from './custom-domain.js';
import { runHealthChecks, printSummary } from './health.js';
import { provisionLicenses } from './licenses.js';
import {
  createEligibilityGroup,
  addGraphPermissions,
  createGraphSubscription,
  grantApplicationAccessPolicy,
} from './rbac-graph.js';
import { sendInstallEvent } from '../licence/phone-home.js';
import * as log from '../utils/log.js';
import chalk from 'chalk';

export async function deploy(ctx: DeployContext): Promise<void> {
  log.heading(`  Deploying to ${ctx.customerSlug} (${ctx.region})`);
  log.blank();

  const deployStart = Date.now();

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

    // Step 5f: Customer VNet + cae-infra subnet. Must exist before CAE and
    //          AKS so the CAE is VNet-integrated and the AKS managed VNet can
    //          be peered to it (enables gateway → Qdrant internal LB).
    await createVnet(ctx);

    // Step 6: Container Apps Environment (VNet-integrated onto cae-infra)
    await createEnvironment(ctx);

    // Step 6b: AKS cluster + Qdrant — provides QDRANT_URL for the gateway.
    //          Skipped if the customer is connector-only; deployAksQdrant is
    //          internally idempotent and logs what it's doing.
    await deployAksQdrant(ctx);

    // Step 7: Import images from ORCA HQ ACR — connectors + core product
    await importImages(ctx);
    await importCoreProductImages(ctx);

    // Step 8: Create Container Apps — connectors first, then core product
    await createContainerApps(ctx);
    await deployCoreProduct(ctx);

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

    // Phone home: install completed. Non-blocking.
    await sendInstallEvent(ctx, 'install.complete', {
      duration_ms: Date.now() - deployStart,
    });
  } catch (err: any) {
    log.blank();
    log.fail(chalk.red.bold(`Deployment failed: ${err.message}`));
    log.blank();
    if (ctx.resourceGroup) {
      log.dim(`To clean up: az group delete --name ${ctx.resourceGroup} --yes --no-wait`);
    }
    // Phone home: install failed. Best-effort — swallows its own errors.
    await sendInstallEvent(ctx, 'install.fail', {
      duration_ms: Date.now() - deployStart,
      // Trim error message to avoid shipping stack traces.
      error: String(err?.message || err).slice(0, 500),
    });
    process.exit(1);
  }
}
