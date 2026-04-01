import { confirm } from '@inquirer/prompts';
import { az, azJson, azTsv } from '../utils/az.js';
import type { PreflightResult } from '../types.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function checkNamingConflicts(customer: string, region: string): Promise<PreflightResult> {
  const rg = naming.resourceGroup(customer, region);
  const acr = naming.acrName(customer, region);
  const kv = naming.keyVaultName(customer, region);

  const conflicts: { resource: string; name: string; detail: string }[] = [];

  // Check resource group
  const rgResult = await az(`group show --name ${rg}`);
  if (rgResult.exitCode === 0) {
    conflicts.push({ resource: 'Resource Group', name: rg, detail: 'already exists' });
  }

  // Check ACR name global availability
  try {
    const acrAvailable = await azTsv(`acr check-name --name ${acr} --query "nameAvailable"`);
    if (acrAvailable === 'false') {
      conflicts.push({ resource: 'Container Registry', name: acr, detail: 'name already taken' });
    }
  } catch { /* ignore — check-name may not be available */ }

  // Check Key Vault (including soft-deleted)
  const kvResult = await az(`keyvault show --name ${kv}`);
  if (kvResult.exitCode === 0) {
    conflicts.push({ resource: 'Key Vault', name: kv, detail: 'already exists' });
  } else {
    try {
      const deleted = await azJson(`keyvault list-deleted --query "[?name=='${kv}']"`);
      if (Array.isArray(deleted) && deleted.length > 0) {
        conflicts.push({ resource: 'Key Vault', name: kv, detail: 'soft-deleted — will need purge or recovery' });
      }
    } catch { /* ignore */ }
  }

  if (conflicts.length === 0) {
    return { label: 'Resource names available (no conflicts)', passed: true };
  }

  // Existing resources found — ask the user about each one
  log.warn('Existing resources detected:');
  log.blank();

  for (const conflict of conflicts) {
    log.dim(`  ${conflict.resource}: ${conflict.name} (${conflict.detail})`);
  }

  log.blank();
  log.dim('This may be from a previous deployment attempt. If these are yours, it is safe to continue.');
  log.dim('The installer will reuse existing resources where possible.');
  log.blank();

  const proceed = await confirm({
    message: 'Continue with existing resources?',
    default: true,
  });

  if (!proceed) {
    return {
      label: 'Resource names available',
      passed: false,
      detail: 'User chose not to continue with existing resources',
      remediation: 'Choose a different customer slug or delete the existing resources',
    };
  }

  return { label: `Resource names: ${conflicts.length} existing resource(s) — user approved`, passed: true };
}
