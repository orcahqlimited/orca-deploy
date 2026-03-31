import chalk from 'chalk';
import type { DeployContext, PreflightResult } from '../types.js';
import { checkAzCli, checkLoggedIn } from './az-cli.js';
import { checkSubscriptionRoles, checkEntraRole } from './permissions.js';
import { checkProviders } from './providers.js';
import { checkNamingConflicts } from './naming.js';
import * as log from '../utils/log.js';

export async function runPreflight(ctx: DeployContext): Promise<boolean> {
  log.heading('  Pre-flight Checks');
  log.blank();

  const checks: PreflightResult[] = [];

  // Sequential checks — each depends on the previous
  const azCliResult = await checkAzCli();
  checks.push(azCliResult);
  printResult(azCliResult);
  if (!azCliResult.passed) return reportFailures(checks);

  const loginResult = await checkLoggedIn();
  checks.push(loginResult);
  printResult(loginResult);
  if (!loginResult.passed) return reportFailures(checks);

  // Tenant and subscription already selected — just confirm
  checks.push({ label: `Tenant: ${ctx.tenantName} (${ctx.tenantId.slice(0, 8)}...)`, passed: true });
  printResult(checks[checks.length - 1]);

  checks.push({ label: `Subscription: ${ctx.subscriptionName} (${ctx.subscriptionId.slice(0, 8)}...)`, passed: true });
  printResult(checks[checks.length - 1]);

  const rolesResult = await checkSubscriptionRoles(ctx.subscriptionId);
  checks.push(rolesResult);
  printResult(rolesResult);
  if (!rolesResult.passed) return reportFailures(checks);

  const entraResult = await checkEntraRole();
  checks.push(entraResult);
  printResult(entraResult);
  if (!entraResult.passed) return reportFailures(checks);

  const providersResult = await checkProviders();
  checks.push(providersResult);
  printResult(providersResult);
  if (!providersResult.passed) return reportFailures(checks);

  const namingResult = await checkNamingConflicts(ctx.customerSlug, ctx.region);
  checks.push(namingResult);
  printResult(namingResult);
  if (!namingResult.passed) return reportFailures(checks);

  log.blank();
  log.success(chalk.green.bold('All pre-flight checks passed'));
  return true;
}

function printResult(result: PreflightResult): void {
  if (result.passed) {
    log.success(result.label);
  } else {
    log.fail(result.label);
    if (result.detail) log.dim(`  ${result.detail}`);
    if (result.remediation) {
      console.log(chalk.yellow(`    Fix: ${result.remediation}`));
    }
  }
}

function reportFailures(checks: PreflightResult[]): boolean {
  log.blank();
  log.fail(chalk.red.bold('Pre-flight check failed. Fix the issue above and re-run.'));
  return false;
}
