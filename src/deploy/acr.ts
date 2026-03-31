import type { DeployContext } from '../types.js';
import { azQuiet, azTsv } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function createAcr(ctx: DeployContext): Promise<void> {
  const acr = naming.acrName(ctx.customerSlug, ctx.region);
  const s = log.spinner(`Container Registry: ${acr}`);

  await azQuiet(`acr create --name ${acr} --resource-group ${ctx.resourceGroup} --location ${ctx.region} --sku Basic`);

  const loginServer = await azTsv(`acr show --name ${acr} --query loginServer`);
  ctx.acrName = acr;
  ctx.acrLoginServer = loginServer;

  // Import base image (CL-2026-0066: Docker Hub rate limits)
  await azQuiet(`acr import --name ${acr} --source docker.io/library/node:20-slim --image node:20-slim`);

  s.succeed(`  Container Registry: ${acr} (base image imported)`);
}
