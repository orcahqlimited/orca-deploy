import type { DeployContext } from '../types.js';
import { azQuiet, azTsv } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function createAcr(ctx: DeployContext): Promise<void> {
  const acr = naming.acrName(ctx.customerSlug, ctx.region);
  const s = log.spinner(`Container Registry: ${acr}`);

  // Create ACR if it doesn't exist (idempotent — create is a no-op if it already exists)
  await azQuiet(`acr create --name ${acr} --resource-group ${ctx.resourceGroup} --location ${ctx.region} --sku Basic`);

  const loginServer = await azTsv(`acr show --name ${acr} --query loginServer`);
  ctx.acrName = acr;
  ctx.acrLoginServer = loginServer;

  // Import base image — --force overwrites if already exists (CL-2026-0066: Docker Hub rate limits)
  await azQuiet(`acr import --name ${acr} --source docker.io/library/node:20-slim --image node:20-slim --force`);

  s.succeed(`  Container Registry: ${acr} (base image imported)`);
}
