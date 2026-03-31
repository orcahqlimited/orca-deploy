import { az, azJson } from '../utils/az.js';
import type { PreflightResult } from '../types.js';

export async function checkAzCli(): Promise<PreflightResult> {
  const result = await az('version');
  if (result.exitCode !== 0) {
    return {
      label: 'Azure CLI installed',
      passed: false,
      remediation: 'Install Azure CLI: https://aka.ms/installazurecli',
    };
  }

  try {
    const version = JSON.parse(result.stdout);
    return {
      label: `Azure CLI installed (v${version['azure-cli']})`,
      passed: true,
    };
  } catch {
    return { label: 'Azure CLI installed', passed: true };
  }
}

export async function checkLoggedIn(): Promise<PreflightResult> {
  try {
    const account = await azJson('account show --query "{name:name, user:user.name}"');
    return {
      label: `Logged in as ${account.user}`,
      passed: true,
    };
  } catch {
    return {
      label: 'Azure CLI logged in',
      passed: false,
      remediation: 'Run: az login',
    };
  }
}
