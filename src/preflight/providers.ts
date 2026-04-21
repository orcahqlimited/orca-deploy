import { azTsv, azQuiet } from '../utils/az.js';
import type { PreflightResult } from '../types.js';
import * as log from '../utils/log.js';

const REQUIRED_PROVIDERS = [
  'Microsoft.App',
  'Microsoft.ContainerRegistry',
  'Microsoft.ContainerService',
  'Microsoft.KeyVault',
  'Microsoft.ManagedIdentity',
  'Microsoft.Network',
  'Microsoft.OperationalInsights',
];

export async function checkProviders(): Promise<PreflightResult> {
  const unregistered: string[] = [];

  for (const provider of REQUIRED_PROVIDERS) {
    try {
      const state = await azTsv(`provider show -n ${provider} --query "registrationState"`);
      if (state !== 'Registered') {
        unregistered.push(provider);
      }
    } catch {
      unregistered.push(provider);
    }
  }

  if (unregistered.length > 0) {
    log.dim(`Registering ${unregistered.length} resource providers...`);
    for (const provider of unregistered) {
      try {
        await azQuiet(`provider register -n ${provider}`);
      } catch {
        return {
          label: 'Resource providers',
          passed: false,
          remediation: `Failed to register ${provider}. Run: az provider register -n ${provider}`,
        };
      }
    }
    log.dim('Waiting for provider registration...');
    // Brief wait for propagation
    await new Promise(r => setTimeout(r, 10_000));
  }

  return {
    label: `Resource providers registered (${REQUIRED_PROVIDERS.length}/${REQUIRED_PROVIDERS.length})`,
    passed: true,
  };
}
