import type { DeployContext } from '../types.js';
import { az, azQuiet, azTsv } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

// INTENT-ORCAHQ-104 §104-E — createCustomerStorage.
//
// Provisions the customer-side Storage Account that holds encrypted
// personal-brain blobs (INTENT-017 envelope encryption: each entry is an
// AES-256-GCM payload wrapped with a DEK that is itself wrapped by the
// RSA-2048 KEK in Key Vault). One account per customer install; one
// container within it called `orca-encrypted-brain`.
//
// Grants the gateway managed identity `Storage Blob Data Contributor` on
// the account so the gateway can write + read encrypted blobs at runtime.
// Surfaces the account name + container name as gateway env vars (set
// later during Container App creation).
//
// Idempotent — checks existence first; storage account names are globally
// unique, so a rerun re-uses the same account.

export async function createCustomerStorage(ctx: DeployContext): Promise<void> {
  const accountName = naming.storageAccountName(ctx.customerSlug, ctx.region);
  const container = naming.ENCRYPTED_BRAIN_CONTAINER;
  const s = log.spinner(`Storage account: ${accountName} / ${container}`);

  const existing = await az(
    `storage account show --name ${accountName} --resource-group ${ctx.resourceGroup}`,
  );
  if (existing.exitCode !== 0) {
    // Standard_LRS is correct for a single-region customer. Encryption at
    // rest on by default; TLS 1.2 minimum; public-blob-access OFF — the
    // gateway MI authenticates via its principal, nothing is anonymous.
    await azQuiet(
      `storage account create --name ${accountName} --resource-group ${ctx.resourceGroup} --location ${ctx.region} --sku Standard_LRS --kind StorageV2 --allow-blob-public-access false --min-tls-version TLS1_2`,
    );
  }

  ctx.storageAccountName = accountName;
  ctx.storageAccountId = await azTsv(
    `storage account show --name ${accountName} --resource-group ${ctx.resourceGroup} --query id`,
  );

  // Container: private, no public access.
  const containerExists = await az(
    `storage container show --account-name ${accountName} --name ${container} --auth-mode login`,
  );
  if (containerExists.exitCode !== 0) {
    await azQuiet(
      `storage container create --account-name ${accountName} --name ${container} --auth-mode login`,
    );
  }

  // Grant the gateway managed identity Storage Blob Data Contributor.
  // Scoped to the account (not just the container) so the MI can also
  // list containers for diagnostics.
  if (ctx.miPrincipalId) {
    await azQuiet(
      `role assignment create --role "Storage Blob Data Contributor" --assignee-object-id ${ctx.miPrincipalId} --assignee-principal-type ServicePrincipal --scope ${ctx.storageAccountId}`,
    ).catch(() => {});
  }

  s.succeed(
    `  Storage account: ${accountName} / ${container} (Blob Data Contributor bound to gateway MI)`,
  );
}
