import { input, password } from '@inquirer/prompts';
import type { ConnectorDef } from '../types.js';
import * as naming from '../utils/naming.js';
import { azTsv } from '../utils/az.js';
import * as log from '../utils/log.js';

/**
 * Return the existing value of a secret in the customer's Key Vault, or
 * null if the secret does not exist yet (or the vault itself doesn't).
 * Never throws — a failed lookup is indistinguishable from a first-run
 * install, and we fall back to prompting in that case.
 */
async function tryReadExistingSecret(
  vault: string,
  name: string,
): Promise<string | null> {
  try {
    const out = await azTsv(
      `keyvault secret show --vault-name ${vault} --name ${name} --query value`,
    );
    const v = (out || '').trim();
    return v || null;
  } catch {
    return null;
  }
}

async function vaultExists(vault: string): Promise<boolean> {
  try {
    const name = await azTsv(`keyvault show --name ${vault} --query name`);
    return !!name.trim();
  } catch {
    return false;
  }
}

export async function collectCredentials(
  connectors: ConnectorDef[],
  customerSlug?: string,
  region?: string,
): Promise<Record<string, string>> {
  const credentials: Record<string, string> = {};
  const resumeMode = !!(
    customerSlug && region && (await vaultExists(naming.keyVaultName(customerSlug, region)))
  );
  const kvName = resumeMode ? naming.keyVaultName(customerSlug!, region!) : null;

  if (resumeMode) {
    log.heading(`  Resume mode — existing install detected`);
    log.dim(`Key Vault ${kvName} already exists. Reading existing secrets from KV; only prompting for missing values.`);
    log.blank();
  }

  for (const connector of connectors) {
    log.heading(`  ${connector.name} Connector — Credentials`);
    log.dim('These are stored in Azure Key Vault. They never leave the customer\'s subscription.');
    log.blank();

    for (const secret of connector.secrets) {
      // Check if the value is already in KV from a prior run
      if (resumeMode && kvName) {
        const existing = await tryReadExistingSecret(kvName, secret.kv);
        if (existing !== null) {
          credentials[secret.kv] = existing;
          log.success(`${secret.label}: reusing existing value from Key Vault`);
          continue;
        }
      }

      const value = secret.masked
        ? await password({
            message: `${secret.label}:`,
            mask: '*',
            validate: (val: string) => {
              if (secret.kv === 'ado-project' || secret.kv === 'isms-base-url') return true;
              if (!val.trim()) return `${secret.label} is required`;
              return true;
            },
          })
        : await input({
            message: `${secret.label}:`,
            validate: (val: string) => {
              if (secret.kv === 'ado-project' || secret.kv === 'isms-base-url') return true;
              if (!val.trim()) return `${secret.label} is required`;
              return true;
            },
          });
      credentials[secret.kv] = value.trim();
    }

    // Set defaults for optional fields
    if (credentials['isms-base-url'] === '') {
      credentials['isms-base-url'] = 'https://rest.api.r1.isms.online';
    }
  }

  return credentials;
}

/**
 * True if the customer's ACR already has the gateway image imported —
 * signals that a prior install got past the image-import phase and we can
 * skip re-prompting for the ACR deployment token.
 */
export async function imagesAlreadyImported(
  customerSlug: string,
  region: string,
): Promise<boolean> {
  const acr = naming.acrName(customerSlug, region);
  try {
    const out = await azTsv(
      `acr repository show --name ${acr} --repository orca-mcp-gateway --query name`,
    );
    return !!out.trim();
  } catch {
    return false;
  }
}
