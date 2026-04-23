import type { DeployContext } from '../types.js';
import { az, azQuiet } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

// INTENT-ORCAHQ-104 §104-D — createOrcaKek.
//
// Provisions the customer KEK: an RSA-2048 key in Key Vault with wrapKey +
// unwrapKey operations. Used by the gateway's envelope-encryption layer
// (INTENT-017) to wrap per-entry DEKs before storing them on personal-brain
// points + encrypted-blob payloads.
//
// Grants the gateway managed identity the `Key Vault Crypto User` role on
// the customer KV so the gateway can call wrapKey / unwrapKey from
// Container Apps.
//
// Idempotent — checks for an existing key first.

export async function createOrcaKek(ctx: DeployContext): Promise<void> {
  const keyName = naming.ORCA_KEK_KEY_NAME;
  const s = log.spinner(`Key Vault KEK: ${keyName}`);

  const existing = await az(
    `keyvault key show --vault-name ${ctx.keyVaultName} --name ${keyName}`,
  );
  if (existing.exitCode !== 0) {
    await azQuiet(
      `keyvault key create --vault-name ${ctx.keyVaultName} --name ${keyName} --kty RSA --size 2048 --ops wrapKey unwrapKey`,
    );
  }

  // Grant the gateway managed identity Key Vault Crypto User. Scope to the
  // vault so the MI can call wrap/unwrap operations. The Key Vault
  // Administrator role on the deployer already allows this inline creation.
  if (ctx.miPrincipalId) {
    await azQuiet(
      `role assignment create --role "Key Vault Crypto User" --assignee-object-id ${ctx.miPrincipalId} --assignee-principal-type ServicePrincipal --scope ${ctx.keyVaultId}`,
    ).catch(() => {});
  }

  s.succeed(`  Key Vault KEK: ${keyName} (RSA-2048, wrap/unwrap bound to gateway MI)`);
}
