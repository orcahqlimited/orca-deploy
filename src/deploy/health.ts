import https from 'node:https';
import type { DeployContext } from '../types.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';
import { printIngestSummary } from './ingest.js';
import chalk from 'chalk';

function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    }).on('error', reject).on('timeout', function (this: any) { this.destroy(); reject(new Error('timeout')); });
  });
}

function httpPost(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write('{}');
    req.end();
  });
}

export async function runHealthChecks(ctx: DeployContext): Promise<boolean> {
  log.heading('  Health Checks');
  let allPassed = true;

  for (const connector of ctx.selectedConnectors) {
    const fqdn = ctx.connectorFqdns[connector.slug];
    if (!fqdn) continue;

    const baseUrl = `https://${fqdn}`;

    // Health check with retries
    let healthStatus = 0;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        healthStatus = await httpGet(`${baseUrl}/health`);
        if (healthStatus === 200) break;
      } catch { /* retry */ }
      if (attempt < 5) await new Promise(r => setTimeout(r, 10_000));
    }

    if (healthStatus === 200) {
      log.success(`${connector.name} /health → ${chalk.green('200')}`);
    } else {
      log.fail(`${connector.name} /health → ${chalk.red(String(healthStatus || 'timeout'))}`);
      allPassed = false;
    }

    // Auth enforcement check
    try {
      const authStatus = await httpPost(`${baseUrl}/mcp`);
      if (authStatus === 401) {
        log.success(`${connector.name} POST /mcp → ${chalk.green('401')} (auth enforced)`);
      } else {
        log.fail(`${connector.name} POST /mcp → ${chalk.red(String(authStatus))} (expected 401)`);
        allPassed = false;
      }
    } catch {
      log.fail(`${connector.name} POST /mcp → timeout`);
      allPassed = false;
    }
  }

  return allPassed;
}

export function printSummary(ctx: DeployContext): void {
  log.blank();
  console.log(chalk.cyan.bold('  ════════════════════════════════════════════════════'));
  console.log(chalk.cyan.bold('  ORCA HQ Intelligence Connectors — Deployment Complete'));
  console.log(chalk.cyan.bold('  ════════════════════════════════════════════════════'));
  log.blank();
  console.log(`  Tenant:       ${chalk.white(ctx.tenantName)} ${chalk.dim(`(${ctx.tenantId})`)}`);
  console.log(`  Subscription: ${chalk.white(ctx.subscriptionName)}`);
  console.log(`  Region:       ${chalk.white(ctx.region)}`);

  for (const connector of ctx.selectedConnectors) {
    const fqdn = ctx.connectorFqdns[connector.slug];
    log.blank();
    log.divider();
    console.log(chalk.white.bold(`  ${connector.name} Connector (${connector.toolCount} tools)`));
    log.divider();
    console.log(`  Status:       ${chalk.green('✓ Healthy')}`);
    log.blank();
    console.log(chalk.dim('  Add to Claude → Settings → MCP Connectors → Add:'));
    console.log(`    ${chalk.cyan('Name:')}             ORCA ${connector.name}`);
    console.log(`    ${chalk.cyan('MCP URL:')}          ${chalk.white(`https://${fqdn}/mcp`)}`);
    console.log(`    ${chalk.cyan('OAuth Client ID:')}  ${chalk.white(ctx.entraAppId!)}`);
    console.log(`    ${chalk.cyan('OAuth Secret:')}     ${chalk.white(ctx.entraClientSecret!)}`);
  }

  // INTENT-106 — engagement-ingest panel + ready-to-run seed command.
  //              No-op if the customer declined the prompt.
  printIngestSummary(ctx);

  // TASK-111 — surface a Foundry-proxy configure failure so the deployer
  // sees it even if the rest of the install reported green. Without this,
  // a transport-level error in configureFoundry leaves the gateway with
  // no foundry-customer-token and every Foundry call from it returns 401.
  if (ctx.foundryConfigureFailed) {
    log.blank();
    log.divider();
    console.log(chalk.red.bold('  ⚠ Foundry-Proxy Token NOT Issued — ACTION REQUIRED'));
    log.divider();
    console.log(`  Reason:       ${chalk.white(ctx.foundryConfigureFailReason || 'unknown')}`);
    console.log(`  Impact:       ${chalk.yellow('gateway will return 401 on every Foundry call until resolved')}`);
    log.blank();
    console.log(chalk.dim('  Resolve before first use:'));
    console.log(chalk.dim('    1. Confirm this host can reach https://license.orcahq.ai (corporate'));
    console.log(chalk.dim('       proxies + TLS interception are the usual culprit).'));
    console.log(chalk.dim('    2. Re-run `orca-deploy` (configureFoundry is idempotent).'));
    console.log(chalk.dim('    3. Or run the manual fallback: see runbook'));
    console.log(chalk.dim('       ORCAHQ-AC-CLAUDE-REDEPLOY-001 §3.5 for the curl recipe.'));
  }

  log.blank();
  log.divider();
  console.log(chalk.dim.bold('  Coming Soon'));
  log.divider();
  console.log(chalk.dim('  ORCA Knowledge Brain    — organisational intelligence store'));
  console.log(chalk.dim('  ORCA Vector Search      — semantic knowledge retrieval'));
  console.log(chalk.dim('  ORCA PII Vault          — encrypted personal data protection'));
  console.log(chalk.dim('  ORCA SimpleX Interface  — private conversational access'));

  log.blank();
  log.divider();
  console.log(chalk.dim('  Entra App Roles — assign to users who need access:'));
  console.log(chalk.dim(`    az ad app show --id ${ctx.entraAppId} --query appRoles`));
  console.log(chalk.dim('    Roles: ORCA.Founder, ORCA.Director, ORCA.Consultant,'));
  console.log(chalk.dim('           ORCA.KnowledgeOperator, ORCA.ReadOnly'));
  log.blank();
  console.log(chalk.green.bold('  All infrastructure is owned by your Azure subscription.'));
  console.log(chalk.green.bold('  ORCA HQ has no access to this deployment.'));
  console.log(chalk.cyan.bold('  ════════════════════════════════════════════════════'));
  log.blank();
}
