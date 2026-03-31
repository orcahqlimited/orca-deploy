import type { DeployContext } from '../types.js';
import { azQuiet, azTsv, azJson } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function createManagedIdentity(ctx: DeployContext): Promise<void> {
  const mi = naming.managedIdentityName(ctx.customerSlug);
  const s = log.spinner(`Managed Identity: ${mi}`);

  await azQuiet(`identity create --name ${mi} --resource-group ${ctx.resourceGroup} --location ${ctx.region}`);

  const identity = await azJson(`identity show --name ${mi} --resource-group ${ctx.resourceGroup} --query "{id:id, principalId:principalId, clientId:clientId}"`);
  ctx.miName = mi;
  ctx.miId = identity.id;
  ctx.miPrincipalId = identity.principalId;
  ctx.miClientId = identity.clientId;

  // Assign RBAC roles
  // Key Vault Secrets User — read secrets at runtime
  await azQuiet(`role assignment create --role "Key Vault Secrets User" --assignee-object-id ${identity.principalId} --assignee-principal-type ServicePrincipal --scope ${ctx.keyVaultId}`);

  // Key Vault Crypto User — for future encryption operations
  await azQuiet(`role assignment create --role "Key Vault Crypto User" --assignee-object-id ${identity.principalId} --assignee-principal-type ServicePrincipal --scope ${ctx.keyVaultId}`);

  // AcrPull — pull container images
  const acrId = await azTsv(`acr show --name ${ctx.acrName} --query id`);
  await azQuiet(`role assignment create --role "AcrPull" --assignee-object-id ${identity.principalId} --assignee-principal-type ServicePrincipal --scope ${acrId}`);

  s.succeed(`  Managed Identity: ${mi} (3 roles assigned)`);

  // Wait for RBAC propagation
  log.dim('  Waiting for RBAC propagation (60s)...');
  await new Promise(r => setTimeout(r, 60_000));
}
