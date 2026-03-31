import type { DeployContext } from '../types.js';
import { azQuiet, azTsv } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function createEnvironment(ctx: DeployContext): Promise<void> {
  const cae = naming.caEnvironmentName(ctx.customerSlug, ctx.region);
  const s = log.spinner(`Container Apps Environment: ${cae}`);

  await azQuiet(`containerapp env create --name ${cae} --resource-group ${ctx.resourceGroup} --location ${ctx.region}`);

  const domain = await azTsv(`containerapp env show --name ${cae} --resource-group ${ctx.resourceGroup} --query "properties.defaultDomain"`);
  ctx.caEnvironment = cae;
  ctx.caDomain = domain;

  s.succeed(`  Container Apps Environment: ${cae}`);
}
