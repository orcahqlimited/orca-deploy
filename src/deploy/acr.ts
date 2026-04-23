import type { DeployContext } from '../types.js';
import { az, azQuiet, azTsv } from '../utils/az.js';
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

  // Import base image — skip if already present (CL-2026-0066: Docker Hub
  // rate limits). --force makes the import itself idempotent when the tag
  // already exists in the target ACR (CL-ORCAHQ-0104); without --force a
  // re-run fails with "Tag node:20-slim already exists in target registry"
  // since `az acr import` without --force treats existing tags as a
  // conflict rather than a no-op. The pre-check below still short-circuits
  // the network call when the image is already there.
  const imageCheck = await az(`acr repository show-tags --name ${acr} --repository node --query "[?contains(@, '20-slim')]" --top 1 -o tsv`);
  const alreadyImported = imageCheck.exitCode === 0 && imageCheck.stdout.trim().length > 0;
  if (!alreadyImported) {
    await azQuiet(`acr import --name ${acr} --source docker.io/library/node:20-slim --image node:20-slim --force`);
  }

  s.succeed(`  Container Registry: ${acr} (base image imported)`);
}
