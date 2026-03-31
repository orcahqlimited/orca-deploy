import { input, select } from '@inquirer/prompts';
import { azJson, azQuiet } from '../utils/az.js';
import * as log from '../utils/log.js';

interface AzAccount {
  name: string;
  id: string;
  tenantId: string;
  isDefault: boolean;
}

export async function selectTenant(): Promise<{ tenantId: string; tenantName: string }> {
  log.heading('  Azure Tenant');

  const accounts: AzAccount[] = await azJson('account list --query "[].{name:name, id:id, tenantId:tenantId, isDefault:isDefault}"');

  // Get unique tenants
  const tenantMap = new Map<string, string>();
  for (const acc of accounts) {
    if (!tenantMap.has(acc.tenantId)) {
      tenantMap.set(acc.tenantId, acc.name);
    }
  }

  const tenants = Array.from(tenantMap.entries()).map(([id, name]) => ({
    name: `${name} (${id})`,
    value: id,
  }));

  let tenantId: string;
  let tenantName: string;

  if (tenants.length === 1) {
    tenantId = tenants[0].value;
    tenantName = tenantMap.get(tenantId) || '';
    log.success(`Tenant: ${tenantName} (${tenantId})`);
  } else {
    tenantId = await select({
      message: 'Select the Azure AD tenant for this deployment:',
      choices: tenants,
    });
    tenantName = tenantMap.get(tenantId) || '';
  }

  // Ensure we're logged into the right tenant
  log.dim('Switching tenant context...');
  await azQuiet(`login --tenant ${tenantId}`);

  return { tenantId, tenantName };
}

export async function selectSubscription(tenantId: string): Promise<{ subscriptionId: string; subscriptionName: string }> {
  log.heading('  Azure Subscription');

  const subs: AzAccount[] = await azJson(`account list --query "[?tenantId=='${tenantId}'].{name:name, id:id, tenantId:tenantId, isDefault:isDefault}"`);

  let subscriptionId: string;
  let subscriptionName: string;

  if (subs.length === 0) {
    throw new Error(`No subscriptions found in tenant ${tenantId}. Ensure you have access.`);
  } else if (subs.length === 1) {
    subscriptionId = subs[0].id;
    subscriptionName = subs[0].name;
    log.success(`Subscription: ${subscriptionName} (${subscriptionId})`);
  } else {
    subscriptionId = await select({
      message: 'Select the Azure subscription:',
      choices: subs.map(s => ({
        name: `${s.name} (${s.id})`,
        value: s.id,
      })),
    });
    subscriptionName = subs.find(s => s.id === subscriptionId)?.name || '';
  }

  await azQuiet(`account set --subscription ${subscriptionId}`);
  log.success(`Active subscription: ${subscriptionName}`);

  return { subscriptionId, subscriptionName };
}
