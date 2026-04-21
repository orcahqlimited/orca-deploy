import { input, select, confirm } from '@inquirer/prompts';
import { REGIONS } from '../types.js';
import * as log from '../utils/log.js';

export async function getCustomerAndRegion(): Promise<{
  customerSlug: string;
  region: string;
  regionShort: string;
  customGatewayDomain?: string;
}> {
  log.heading('  Customer & Region');

  const customerSlug = await input({
    message: 'Customer name (lowercase, 3-10 chars, alphanumeric):',
    validate: (val: string) => {
      if (!/^[a-z0-9]{3,10}$/.test(val)) {
        return 'Must be 3-10 lowercase alphanumeric characters';
      }
      return true;
    },
  });

  const regionChoices = Object.entries(REGIONS).map(([region, short]) => ({
    name: `${region} (${short})`,
    value: region,
  }));

  const region = await select({
    message: 'Azure region:',
    choices: regionChoices,
    default: 'uksouth',
  });

  const regionShort = REGIONS[region] || region.slice(0, 3);

  // Optional custom domain — customer-owned hostname for the gateway.
  // Skip path: deploy binds the Azure-assigned *.azurecontainerapps.io FQDN
  // only, and GATEWAY_URL is set from that.
  const wantsCustomDomain = await confirm({
    message: 'Bind a custom domain to the gateway? (e.g. gateway.example.com)',
    default: false,
  });
  let customGatewayDomain: string | undefined;
  if (wantsCustomDomain) {
    customGatewayDomain = await input({
      message: 'Gateway hostname (no scheme, no trailing slash):',
      validate: (val: string) => {
        if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(val)) {
          return 'Must be a valid lowercase hostname (letters, digits, dots, hyphens)';
        }
        if (!val.includes('.')) return 'Must be a fully qualified domain (e.g. gateway.example.com)';
        if (val.endsWith('.azurecontainerapps.io')) {
          return 'Do not pass the Azure-assigned FQDN — that binds automatically';
        }
        return true;
      },
    });
    log.dim(
      `  After the gateway Container App is created, the CLI will print the`
    );
    log.dim(
      `  exact CNAME + asuid TXT records to add. For Microsoft 365-managed`
    );
    log.dim(
      `  domains, add them via admin.microsoft.com → Settings → Domains →`
    );
    log.dim(
      `  <domain> → DNS records. Otherwise add them at your DNS provider.`
    );
  }

  log.success(
    `Customer: ${customerSlug}, Region: ${region} (${regionShort})` +
      (customGatewayDomain ? `, Domain: ${customGatewayDomain}` : '')
  );

  return { customerSlug, region, regionShort, customGatewayDomain };
}
