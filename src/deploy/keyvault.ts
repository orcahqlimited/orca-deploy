import crypto from 'node:crypto';
import type { DeployContext } from '../types.js';
import { azQuiet, azTsv } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function createKeyVault(ctx: DeployContext): Promise<void> {
  const kv = naming.keyVaultName(ctx.customerSlug, ctx.region);
  const s = log.spinner(`Key Vault: ${kv}`);

  // Create with RBAC authorization
  await azQuiet(`keyvault create --name ${kv} --resource-group ${ctx.resourceGroup} --location ${ctx.region} --enable-rbac-authorization true`);

  const kvId = await azTsv(`keyvault show --name ${kv} --query id`);
  ctx.keyVaultName = kv;
  ctx.keyVaultId = kvId;

  // Assign deployer as Key Vault Administrator so they can write secrets
  const deployerOid = await azTsv('ad signed-in-user show --query id');
  await azQuiet(`role assignment create --role "Key Vault Administrator" --assignee-object-id ${deployerOid} --assignee-principal-type User --scope ${kvId}`);

  // Wait for RBAC propagation
  await new Promise(r => setTimeout(r, 15_000));

  // Generate JWT signing key
  ctx.jwtSigningKey = crypto.randomBytes(64).toString('hex');

  // Store shared secrets
  await azQuiet(`keyvault secret set --vault-name ${kv} --name connector-jwt-key --value "${ctx.jwtSigningKey}"`);

  // Store connector-specific secrets from user prompts
  let secretCount = 1; // connector-jwt-key
  for (const [kvName, value] of Object.entries(ctx.credentials)) {
    if (value) {
      await azQuiet(`keyvault secret set --vault-name ${kv} --name ${kvName} --value "${value.replace(/"/g, '\\"')}"`);
      secretCount++;
    }
  }

  s.succeed(`  Key Vault: ${kv} (${secretCount} secrets)`);
}
