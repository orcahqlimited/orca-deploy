import { execaCommand } from 'execa';
import type { DeployContext } from '../types.js';
import * as log from '../utils/log.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as url from 'node:url';

// INTENT-ORCAHQ-104 §104-U — runEstateReport.
//
// Runs scripts/orca-estate-report.ps1 as the final step of the installer.
// The report is read-only (no mutations), prints an [OK]/[WARN]/[FAIL]
// summary of what was provisioned, and exits 0 on a clean deploy. The
// `install.complete` phone-home event only fires when this exit is 0 —
// that way HQ telemetry reflects whether the deploy was truly complete,
// not just whether the deploy flow reached its final statement.
//
// If pwsh is not on PATH, the step logs a clear path to the script and a
// command the customer can run manually, then returns `notRun = true`
// so the caller decides whether to fire install.complete anyway.

export interface EstateReportResult {
  ran: boolean;
  exitCode: number | null;
  reportPath?: string;
}

export async function runEstateReport(ctx: DeployContext): Promise<EstateReportResult> {
  const s = log.spinner('Estate report');

  // Locate the script relative to this module. In the compiled dist/ layout
  // the script sits at ../../scripts/orca-estate-report.ps1 from
  // dist/deploy/estate-report.js (scripts/ is copied into the image
  // alongside dist/). In the source tree it's at the same relative path
  // from src/deploy/estate-report.ts, so import.meta.url + resolve works
  // either way.
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../scripts/orca-estate-report.ps1'),    // dist layout
    path.resolve(here, '../../../scripts/orca-estate-report.ps1'), // src layout
  ];
  const scriptPath = candidates.find((p) => fs.existsSync(p));
  if (!scriptPath) {
    s.warn('  Estate report: script not found in expected locations');
    return { ran: false, exitCode: null };
  }

  // pwsh probe. Azure CLI ships with .NET but not pwsh on Debian; the
  // orca-installer Dockerfile installs pwsh from the Microsoft apt repo
  // starting with v0.2.4 (INTENT-104 §104-R). If pwsh is missing we print
  // a manual path and skip.
  const probe = await execaCommand('pwsh -Version', {
    shell: true,
    reject: false,
    timeout: 5_000,
  });
  if (probe.exitCode !== 0) {
    s.warn('  Estate report: pwsh not found — skipping (run manually with the command below)');
    log.dim(`      pwsh ${scriptPath} ${ctx.customerSlug} ${ctx.region} -Save ~/orca-estate-${ctx.customerSlug}.md`);
    return { ran: false, exitCode: null };
  }

  // Run the report with -Save so we have a persisted artefact per install.
  const reportPath = path.join(
    process.env.HOME || '/tmp',
    `orca-estate-${ctx.customerSlug}-${Date.now()}.md`,
  );
  const cmd = `pwsh -NoProfile -File "${scriptPath}" "${ctx.customerSlug}" "${ctx.region}" -Save "${reportPath}"`;
  const result = await execaCommand(cmd, {
    shell: true,
    reject: false,
    timeout: 180_000,
  });

  if (result.exitCode === 0) {
    s.succeed(`  Estate report: clean (saved to ${reportPath})`);
  } else {
    s.warn(
      `  Estate report: exit ${result.exitCode} — see ${reportPath} for the [FAIL] items`,
    );
  }
  return { ran: true, exitCode: result.exitCode ?? null, reportPath };
}
