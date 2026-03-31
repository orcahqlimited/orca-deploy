import { az, azJson, azTsv } from '../utils/az.js';
import type { PreflightResult } from '../types.js';
import * as naming from '../utils/naming.js';

export async function checkNamingConflicts(customer: string, region: string): Promise<PreflightResult> {
  const rg = naming.resourceGroup(customer, region);
  const acr = naming.acrName(customer, region);
  const kv = naming.keyVaultName(customer, region);

  const conflicts: string[] = [];

  // Check resource group
  const rgResult = await az(`group show --name ${rg}`);
  if (rgResult.exitCode === 0) {
    conflicts.push(`Resource group '${rg}' already exists`);
  }

  // Check ACR name global availability
  try {
    const acrAvailable = await azTsv(`acr check-name --name ${acr} --query "nameAvailable"`);
    if (acrAvailable === 'false') {
      conflicts.push(`ACR name '${acr}' is already taken globally`);
    }
  } catch { /* ignore — check-name may not be available */ }

  // Check Key Vault (including soft-deleted)
  const kvResult = await az(`keyvault show --name ${kv}`);
  if (kvResult.exitCode === 0) {
    conflicts.push(`Key Vault '${kv}' already exists`);
  }
  try {
    const deleted = await azJson(`keyvault list-deleted --query "[?name=='${kv}']"`);
    if (Array.isArray(deleted) && deleted.length > 0) {
      conflicts.push(`Key Vault '${kv}' is in soft-deleted state. Purge it first: az keyvault purge --name ${kv}`);
    }
  } catch { /* ignore */ }

  if (conflicts.length > 0) {
    return {
      label: 'Resource names available',
      passed: false,
      detail: conflicts.join('\n  '),
      remediation: 'Choose a different customer slug or resolve the conflicts above',
    };
  }

  return { label: 'Resource names available (no conflicts)', passed: true };
}
