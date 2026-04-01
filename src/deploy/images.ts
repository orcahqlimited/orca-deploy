import type { DeployContext } from '../types.js';
import { azQuiet } from '../utils/az.js';
import { ORCA_HQ_ACR, IMAGE_TAGS } from '../utils/config.js';
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
