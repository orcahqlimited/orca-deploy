import { input, password } from '@inquirer/prompts';
import type { ConnectorDef } from '../types.js';
import * as log from '../utils/log.js';

export async function collectCredentials(connectors: ConnectorDef[]): Promise<Record<string, string>> {
  const credentials: Record<string, string> = {};

  for (const connector of connectors) {
    log.heading(`  ${connector.name} Connector — Credentials`);
    log.dim('These are stored in Azure Key Vault. They never leave the customer\'s subscription.');
    log.blank();

    for (const secret of connector.secrets) {
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
