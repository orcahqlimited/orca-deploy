// Customer VNet + subnet provisioning.
//
// Why this exists:
//   The gateway runs in a Container Apps Environment (CAE) and needs to reach
//   the Qdrant internal load balancer VIP sitting inside the AKS-managed VNet.
//   A default (non-VNet-integrated) CAE lives on Microsoft's shared network
//   and cannot route to private IPs inside a customer-scoped AKS VNet, so
//   every brain call would time out.
//
// The fix mirrors ORCA HQ production (orcahq-vnet-uks + cae-to-aks peering):
//   1. Create a customer-scoped VNet with a dedicated `cae-infra` subnet
//      delegated to Microsoft.App/environments.
//   2. Create the CAE with --infrastructure-subnet-resource-id pointing at it
//      (see environment.ts).
//   3. After AKS is created (it still uses its own managed VNet), peer the
//      two VNets bidirectionally (see peerAksVnet in aks-qdrant.ts).
//
// Address plan (matches ORCA HQ):
//   VNet:       10.100.0.0/16
//   cae-infra:  10.100.0.0/23   (delegated to Microsoft.App/environments)
//
// AKS brings its own default 10.224.0.0/12 managed VNet — no overlap with
// 10.100.0.0/16, so peering is clean.

import type { DeployContext } from '../types.js';
import { az, azQuiet, azTsv } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

const VNET_ADDRESS_SPACE = '10.100.0.0/16';
const CAE_INFRA_SUBNET_PREFIX = '10.100.0.0/23';
const CAE_INFRA_SUBNET_NAME = 'cae-infra';

export async function createVnet(ctx: DeployContext): Promise<void> {
  const vnetName = naming.vnetName(ctx.customerSlug, ctx.region);
  const s = log.spinner(`VNet: ${vnetName}`);

  // 1. VNet — idempotent via az network vnet create (no-op if exists).
  await azQuiet(
    `network vnet create --name ${vnetName} --resource-group ${ctx.resourceGroup} ` +
      `--location ${ctx.region} --address-prefixes ${VNET_ADDRESS_SPACE}`
  );

  // 2. cae-infra subnet, delegated to Microsoft.App/environments. Check first,
  //    then create — `subnet create` errors if it already exists, even with the
  //    same config, so we must branch on existence.
  const existing = await az(
    `network vnet subnet show --name ${CAE_INFRA_SUBNET_NAME} --vnet-name ${vnetName} ` +
      `--resource-group ${ctx.resourceGroup}`
  );
  if (existing.exitCode !== 0) {
    await azQuiet(
      `network vnet subnet create --name ${CAE_INFRA_SUBNET_NAME} --vnet-name ${vnetName} ` +
        `--resource-group ${ctx.resourceGroup} --address-prefixes ${CAE_INFRA_SUBNET_PREFIX} ` +
        `--delegations Microsoft.App/environments`
    );
  } else {
    // Confirm the delegation is still in place (defensive — manual edits happen).
    const delegation = await azTsv(
      `network vnet subnet show --name ${CAE_INFRA_SUBNET_NAME} --vnet-name ${vnetName} ` +
        `--resource-group ${ctx.resourceGroup} --query "delegations[0].serviceName"`
    ).catch(() => '');
    if (delegation !== 'Microsoft.App/environments') {
      await azQuiet(
        `network vnet subnet update --name ${CAE_INFRA_SUBNET_NAME} --vnet-name ${vnetName} ` +
          `--resource-group ${ctx.resourceGroup} --delegations Microsoft.App/environments`
      );
    }
  }

  const subnetId = await azTsv(
    `network vnet subnet show --name ${CAE_INFRA_SUBNET_NAME} --vnet-name ${vnetName} ` +
      `--resource-group ${ctx.resourceGroup} --query "id"`
  );
  const vnetId = await azTsv(
    `network vnet show --name ${vnetName} --resource-group ${ctx.resourceGroup} --query "id"`
  );

  ctx.vnetName = vnetName;
  ctx.vnetId = vnetId;
  ctx.caeSubnetId = subnetId;

  s.succeed(
    `  VNet: ${vnetName} (${VNET_ADDRESS_SPACE})  subnet: ${CAE_INFRA_SUBNET_NAME} (${CAE_INFRA_SUBNET_PREFIX})`
  );
}

/**
 * Bidirectional peering between the customer VNet and the AKS-managed VNet.
 * Runs AFTER AKS has been created (so its managed VNet exists).
 *
 * Idempotent — checks for an existing peering with the target id before creating.
 */
export async function peerAksVnet(ctx: DeployContext): Promise<void> {
  if (!ctx.vnetName || !ctx.vnetId) {
    throw new Error('peerAksVnet requires ctx.vnetName and ctx.vnetId (createVnet must run first)');
  }
  if (!ctx.aksResourceGroup || !ctx.aksClusterName) {
    throw new Error('peerAksVnet requires AKS to have been created (ctx.aksResourceGroup missing)');
  }

  const s = log.spinner(`VNet peering: customer ↔ AKS`);

  // Find the AKS-managed node resource group + the managed VNet inside it.
  const nodeRg = await azTsv(
    `aks show --name ${ctx.aksClusterName} --resource-group ${ctx.aksResourceGroup} ` +
      `--query "nodeResourceGroup"`
  );
  const aksVnetName = await azTsv(
    `network vnet list --resource-group ${nodeRg} --query "[0].name"`
  );
  const aksVnetId = await azTsv(
    `network vnet show --name ${aksVnetName} --resource-group ${nodeRg} --query "id"`
  );

  // 1. Customer VNet → AKS VNet
  const peerName1 = 'cae-to-aks';
  const existing1 = await az(
    `network vnet peering show --name ${peerName1} --vnet-name ${ctx.vnetName} ` +
      `--resource-group ${ctx.resourceGroup}`
  );
  if (existing1.exitCode !== 0) {
    await azQuiet(
      `network vnet peering create --name ${peerName1} --vnet-name ${ctx.vnetName} ` +
        `--resource-group ${ctx.resourceGroup} --remote-vnet ${aksVnetId} ` +
        `--allow-vnet-access`
    );
  }

  // 2. AKS VNet → Customer VNet
  const peerName2 = 'aks-to-cae';
  const existing2 = await az(
    `network vnet peering show --name ${peerName2} --vnet-name ${aksVnetName} ` +
      `--resource-group ${nodeRg}`
  );
  if (existing2.exitCode !== 0) {
    await azQuiet(
      `network vnet peering create --name ${peerName2} --vnet-name ${aksVnetName} ` +
        `--resource-group ${nodeRg} --remote-vnet ${ctx.vnetId} ` +
        `--allow-vnet-access`
    );
  }

  s.succeed(`  VNet peering: ${ctx.vnetName} ↔ ${aksVnetName}`);
}
