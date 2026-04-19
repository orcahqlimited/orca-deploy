import type { DeployContext } from '../types.js';
import { azQuiet } from '../utils/az.js';
import { ORCA_HQ_ACR, IMAGE_TAGS, CORE_PRODUCT_IMAGES } from '../utils/config.js';
import * as log from '../utils/log.js';

export async function importImages(ctx: DeployContext): Promise<void> {
  for (const connector of ctx.selectedConnectors) {
    const tag = IMAGE_TAGS[connector.image] || 'rc-latest';
    const source = `${ORCA_HQ_ACR}/${connector.image}:${tag}`;
    const target = `${connector.image}:${tag}`;

    const s = log.spinner(`Importing ${connector.name} image (${tag})`);

    await azQuiet(
      `acr import --name ${ctx.acrName} --source ${source} --image ${target} --username orca-deploy-token --password "${ctx.orcaAcrToken}" --force`
    );

    s.succeed(`  ${connector.name} image imported (${tag})`);
  }
}

/**
 * Import the core ORCA product images (gateway, copilot, governance portal,
 * licence service) from ORCA HQ ACR into the customer ACR. Idempotent — uses
 * --force so repeat runs simply overwrite. Tags are pinned from IMAGE_TAGS.
 */
export async function importCoreProductImages(ctx: DeployContext): Promise<void> {
  for (const image of CORE_PRODUCT_IMAGES) {
    const tag = IMAGE_TAGS[image] || 'rc-latest';
    const source = `${ORCA_HQ_ACR}/${image}:${tag}`;
    const target = `${image}:${tag}`;

    const s = log.spinner(`Importing ${image} image (${tag})`);

    await azQuiet(
      `acr import --name ${ctx.acrName} --source ${source} --image ${target} --username orca-deploy-token --password "${ctx.orcaAcrToken}" --force`
    );

    s.succeed(`  ${image} image imported (${tag})`);
  }
}
