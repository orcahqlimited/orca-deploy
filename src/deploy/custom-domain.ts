// Custom domain binding for the gateway Container App.
//
// Flow:
//   1. After the gateway Container App exists and has its azure-assigned FQDN,
//      print the required CNAME target for the customer's DNS team.
//   2. Wait for the operator to confirm the CNAME has been created.
//   3. Bind the hostname on the Container App.
//   4. Issue a managed certificate at the environment level.
//   5. Bind the cert to the hostname on the app.
//   6. Once ingress shows the new FQDN active, flip ctx.gatewayUrl so
//      subsequent deploys (copilot, governance portal/connector, Graph
//      subscription) use the custom URL — and re-update the gateway app so
//      its own GATEWAY_URL env var and Entra redirect URIs point at the
//      custom host too.
//
// DNS validation: Container Apps accepts either a CNAME (most common for
// subdomains) or an A/TXT verification record for apex domains. We currently
// only support the CNAME path because AgileCadence (and likely most initial
// customers) will use a subdomain (e.g. gateway.agilecadence.co.uk).
//
// Idempotent: each step checks state and skips if already done.

import { confirm } from '@inquirer/prompts';
import type { DeployContext } from '../types.js';
import { az, azQuiet, azTsv, azJson } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

const VERIFICATION_POLL_INTERVAL_MS = 10_000;
const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;

export async function bindCustomGatewayDomain(ctx: DeployContext): Promise<void> {
  if (!ctx.customGatewayDomain) return;
  if (!ctx.gatewayFqdn) {
    log.warn('Custom domain requested but gateway FQDN not set — skipping bind.');
    return;
  }

  const host = ctx.customGatewayDomain;
  const appName = naming.gatewayAppName(ctx.customerSlug);

  log.heading('  Custom Domain — Gateway');
  log.blank();
  log.info(`  Target hostname: ${host}`);
  log.info(`  Container App:   ${appName}`);
  log.blank();

  // ─── 1. Print CNAME + verification TXT ────────────────────────────────
  // containerapp hostname show returns the verification id we need; if the
  // hostname isn't bound yet, we use the environment's verification id instead.
  const envVerificationId = await azTsv(
    `containerapp env show --name ${ctx.caEnvironment} --resource-group ${ctx.resourceGroup} ` +
      `--query "properties.customDomainConfiguration.customDomainVerificationId"`
  ).catch(() => '');

  log.info('  DNS records required in the customer tenant:');
  log.dim(`    CNAME  ${host}  →  ${ctx.gatewayFqdn}`);
  if (envVerificationId) {
    log.dim(`    TXT    asuid.${host}  →  ${envVerificationId}`);
  }
  log.blank();
  log.warn(
    '  The customer DNS team must create these records before we proceed.'
  );
  log.dim(
    '  TTL 300s is fine. Propagation usually takes 2-5 minutes.'
  );
  log.blank();

  const proceed = await confirm({
    message: `Have the CNAME and TXT records been created for ${host}?`,
    default: false,
  });
  if (!proceed) {
    log.warn('  Skipping custom domain bind — run the CLI again when DNS is ready.');
    return;
  }

  // ─── 2. Bind the hostname ────────────────────────────────────────────
  const existingHostnames = await azJson(
    `containerapp hostname list --name ${appName} --resource-group ${ctx.resourceGroup}`
  ).catch(() => [] as Array<{ name: string }>);
  const alreadyBound = Array.isArray(existingHostnames)
    ? existingHostnames.some((h) => h && h.name === host)
    : false;

  if (!alreadyBound) {
    const s = log.spinner(`Adding hostname ${host}`);
    await azQuiet(
      `containerapp hostname add --name ${appName} --resource-group ${ctx.resourceGroup} ` +
        `--hostname ${host}`
    );
    s.succeed(`  Hostname ${host} added to ${appName}`);
  } else {
    log.dim(`  Hostname ${host} already bound — skipping add`);
  }

  // ─── 3. Managed cert ─────────────────────────────────────────────────
  // Managed certs live at the environment level and are issued asynchronously.
  // We always check first, then issue if missing. Cert name must be short.
  const certName = `cert-${host.replace(/\./g, '-').slice(0, 40)}`;
  const existingCert = await az(
    `containerapp env certificate show --name ${ctx.caEnvironment} --resource-group ${ctx.resourceGroup} ` +
      `--certificate ${certName}`
  );

  if (existingCert.exitCode !== 0) {
    const s = log.spinner(`Issuing managed certificate for ${host}`);
    // The managed-cert create is synchronous on the CLI surface but the
    // underlying ARM op can take a couple of minutes. We tolerate the wait.
    const result = await az(
      `containerapp env certificate create --name ${ctx.caEnvironment} --resource-group ${ctx.resourceGroup} ` +
        `--certificate-name ${certName} --hostname ${host} --validation-method CNAME`
    );
    if (result.exitCode !== 0) {
      s.fail(`  Managed certificate failed: ${result.stderr.slice(0, 200)}`);
      log.dim(
        '  Most common cause: DNS records not yet propagated. Wait a few minutes and retry.'
      );
      return;
    }
    s.succeed(`  Managed certificate issued for ${host}`);
  } else {
    log.dim(`  Managed certificate ${certName} already exists — skipping issue`);
  }

  // ─── 4. Resolve cert resource id + bind to hostname ──────────────────
  const certId = await azTsv(
    `containerapp env certificate show --name ${ctx.caEnvironment} --resource-group ${ctx.resourceGroup} ` +
      `--certificate ${certName} --query "id"`
  );

  const bindSpinner = log.spinner(`Binding certificate to ${host}`);
  await azQuiet(
    `containerapp hostname bind --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--hostname ${host} --environment ${ctx.caEnvironment} --certificate ${certId}`
  );
  bindSpinner.succeed(`  Certificate bound — ${host} serving https`);

  // ─── 5. Flip ctx.gatewayUrl to the custom host ───────────────────────
  // Every downstream deploy reads ctx.gatewayUrl; switching now means the
  // gateway re-deploy below, copilot, governance connector, governance portal,
  // and the Graph subscription all pick up the custom hostname.
  ctx.gatewayUrl = `https://${host}`;
  ctx.customGatewayDomainBound = true;

  log.info(`  GATEWAY_URL switched to ${ctx.gatewayUrl} for downstream deploys`);
  log.blank();
}

// Wait for the hostname to be reachable over HTTPS before continuing. Not all
// callers need this — the gateway re-deploy step later in the flow already
// refreshes env vars — but useful for sanity during debugging.
export async function waitForHostnameLive(host: string): Promise<boolean> {
  const deadline = Date.now() + VERIFICATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // Node's fetch — we use it here (outside the gateway repo) because this
      // is the deployer CLI, not the gateway itself. The no-fetch rule in
      // CLAUDE.md is specific to gateway code running in Container Apps.
      const res = await fetch(`https://${host}/health`, {
        redirect: 'manual',
      });
      if (res.status >= 200 && res.status < 500) return true;
    } catch {
      // swallow — still propagating
    }
    await new Promise((r) => setTimeout(r, VERIFICATION_POLL_INTERVAL_MS));
  }
  return false;
}
