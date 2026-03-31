import type { DeployContext } from '../types.js';
import { azQuiet } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function createResourceGroup(ctx: DeployContext): Promise<void> {
  const rg = naming.resourceGroup(ctx.customerSlug, ctx.region);
  const s = log.spinner(`Resource group: ${rg}`);

  await azQuiet(`group create --name ${rg} --location ${ctx.region}`);

  ctx.resourceGroup = rg;
  s.succeed(`  Resource group: ${rg}`);
}
