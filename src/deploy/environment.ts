import type { DeployContext } from '../types.js';
import { az, azQuiet, azTsv } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function createEnvironment(ctx: DeployContext): Promise<void> {
  const cae = naming.caEnvironmentName(ctx.customerSlug, ctx.region);
  const s = log.spinner(`Container Apps Environment: ${cae}`);

  if (!ctx.caeSubnetId) {
    throw new Error(
      'createEnvironment requires ctx.caeSubnetId — createVnet must run before createEnvironment'
    );
  }

  // Idempotent: check first, then create. We cannot add infrastructure-subnet
  // to an existing environment — it is immutable after creation — so if the
  // environment exists and is on a different subnet, fail loudly rather than
  // silently leaving it disconnected from the VNet.
  const existing = await az(
    `containerapp env show --name ${cae} --resource-group ${ctx.resourceGroup}`
  );
  if (existing.exitCode === 0) {
    const boundSubnet = await azTsv(
      `containerapp env show --name ${cae} --resource-group ${ctx.resourceGroup} ` +
        `--query "properties.vnetConfiguration.infrastructureSubnetId"`
    ).catch(() => '');
    if (boundSubnet && boundSubnet.toLowerCase() !== ctx.caeSubnetId.toLowerCase()) {
      s.fail(`  Container Apps Environment: ${cae} (subnet mismatch — manual fix required)`);
      throw new Error(
        `Existing CAE ${cae} is bound to a different subnet:\n` +
          `  current:  ${boundSubnet}\n` +
          `  expected: ${ctx.caeSubnetId}\n` +
          `Infrastructure subnet is immutable — delete the CAE to re-create with the correct subnet.`
      );
    }
  } else {
    await azQuiet(
      `containerapp env create --name ${cae} --resource-group ${ctx.resourceGroup} ` +
        `--location ${ctx.region} --infrastructure-subnet-resource-id "${ctx.caeSubnetId}" ` +
        `--internal-only false`
    );
  }

  const domain = await azTsv(
    `containerapp env show --name ${cae} --resource-group ${ctx.resourceGroup} ` +
      `--query "properties.defaultDomain"`
  );
  ctx.caEnvironment = cae;
  ctx.caDomain = domain;

  s.succeed(`  Container Apps Environment: ${cae} (VNet-integrated)`);
}
