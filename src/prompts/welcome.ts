import { input, select } from '@inquirer/prompts';
import { REGIONS } from '../types.js';
import * as log from '../utils/log.js';

export async function getCustomerAndRegion(): Promise<{ customerSlug: string; region: string; regionShort: string }> {
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

  log.success(`Customer: ${customerSlug}, Region: ${region} (${regionShort})`);

  return { customerSlug, region, regionShort };
}
