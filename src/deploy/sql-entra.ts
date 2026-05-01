// =============================================================================
// src/deploy/sql-entra.ts
//
// INTENT-108 §108-J + TASK-103 — customer-side prerequisite for the
// gateway's Entra-only SQL auth path.
//
// The gateway image at `rc-1.0.0` past commit `1b09acd` (gateway tag
// v0.2.5) authenticates to SQL via the gateway MI using
// `DefaultAzureCredential`. For that to work, the MI must exist as a
// SQL database principal in `orca-pii-vault` with read+write+execute
// permissions. Without this, the gateway's first SQL operation returns
// "Login failed" / `principal does not exist`.
//
// Gateway sql-pool.mjs comments (the contract this implements):
//   1. SQL server has an Entra admin set
//   2. CREATE USER [orca-<customer>-mi] FROM EXTERNAL PROVIDER on each DB
//   3. Role grants: db_datareader + db_datawriter + EXECUTE ON SCHEMA::dbo
//   4. (Later) az sql server ad-only-auth enable
//
// This module covers (1)–(3) for `orca-pii-vault` only — customer
// installs do not run `orca-support` (HQ-only DB).
//
// We do NOT flip `aadOnlyAuthentications=true` here. That's the v0.3.0
// step (108-J customer-side full lockdown) which only happens after
// rc-1.0.0 is confirmed Entra-talking everywhere. Keeping dual-auth on
// the customer side preserves the SQL-admin fallback for emergency
// access. This is the conservative cut for v0.2.5.
//
// Both sub-steps are idempotent:
//   - `sql server ad-admin create` succeeds with no-op when the same
//     identity is already set; if a different admin is set we update
//     to the deployer (the regular case is "deployer re-runs install").
//   - The CREATE USER DDL is wrapped in `IF NOT EXISTS`.
//
// Failure modes:
//   - Missing sqlcmd → log manual fallback, continue install
//   - Token acquisition failed (no az session) → log manual fallback
//   - sqlcmd exit non-zero → log full output + manual fallback
//
// The install never aborts on this step. The customer ends up with a
// working DB schema either way; the gateway's first SQL call surfaces
// the missing-user error with a clear log line if the manual step
// wasn't run.
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execaCommand } from 'execa';
import type { DeployContext } from '../types.js';
import { az, azQuiet, azTsv } from '../utils/az.js';
import { SQL_PII_VAULT_DB } from '../utils/naming.js';
import * as log from '../utils/log.js';

// DDL is parameterised on the MI display name so the same module can
// be reused if/when the customer-side `orca-support` DB is ever added.
function entraUserDdl(miName: string): string {
  // Single-statement IF/ELSE so sqlcmd's -b (abort on error) doesn't
  // trip on the second pass after the user already exists.
  return `
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '${miName}')
BEGIN
    CREATE USER [${miName}] FROM EXTERNAL PROVIDER;
    ALTER ROLE db_datareader ADD MEMBER [${miName}];
    ALTER ROLE db_datawriter ADD MEMBER [${miName}];
    GRANT EXECUTE ON SCHEMA::dbo TO [${miName}];
    PRINT 'created_${miName}';
END
ELSE
BEGIN
    PRINT 'exists_${miName}';
END
`;
}

export async function grantGatewayMiSqlAccess(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Azure SQL: gateway MI Entra-user grant');

  if (!ctx.sqlServerName || !ctx.sqlServerFqdn || !ctx.miName || !ctx.resourceGroup) {
    s.warn('  SQL Entra: missing prerequisite ctx fields — skipped');
    return;
  }

  // ─── Step 1: ensure deployer is the SQL Entra admin ─────────────────────
  const founderInfo = await resolveDeployer(ctx);
  if (!founderInfo) {
    s.fail('  SQL Entra: could not resolve signed-in user — skipped');
    printManualFallback(ctx);
    return;
  }
  const { founderOid, founderUpn } = founderInfo;

  await ensureSqlEntraAdmin(ctx, founderUpn, founderOid);

  // ─── Step 2: acquire a SQL access token ──────────────────────────────────
  let token: string;
  try {
    token = await azTsv(
      `account get-access-token --resource https://database.windows.net/ --query accessToken`,
    );
  } catch (err: any) {
    s.fail(
      `  SQL Entra: could not acquire SQL access token (${err.message}) — skipped`,
    );
    printManualFallback(ctx);
    return;
  }

  // ─── Step 3: run CREATE USER + grants via sqlcmd ─────────────────────────
  const ok = await runEntraDdl(ctx, token);
  if (ok) {
    s.succeed(
      `  Azure SQL: ${ctx.miName} is a database user in ${SQL_PII_VAULT_DB} (db_datareader + db_datawriter + EXECUTE ON dbo)`,
    );
  } else {
    s.warn('  SQL Entra: CREATE USER step did not complete — manual follow-up required');
    printManualFallback(ctx);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function resolveDeployer(
  ctx: DeployContext,
): Promise<{ founderOid: string; founderUpn: string } | null> {
  try {
    const founderOid = ctx.founderOid ?? (await azTsv(`ad signed-in-user show --query id`));
    if (!ctx.founderOid) ctx.founderOid = founderOid;
    const founderUpn = await azTsv(`ad signed-in-user show --query userPrincipalName`);
    return { founderOid, founderUpn };
  } catch {
    return null;
  }
}

/**
 * Set the deployer as the Entra admin on the SQL server.
 *
 * Tries `create` first; if `create` fails because an admin is already set
 * with a different identity, falls back to `update` to overwrite it. If
 * both fail, logs a warn — the existing admin may be a previous deployer
 * who can still complete the manual step.
 */
async function ensureSqlEntraAdmin(
  ctx: DeployContext,
  founderUpn: string,
  founderOid: string,
): Promise<void> {
  const create = await az(
    `sql server ad-admin create --resource-group ${ctx.resourceGroup} --server ${ctx.sqlServerName} --display-name "${founderUpn}" --object-id ${founderOid}`,
  );
  if (create.exitCode === 0) return;

  // Some az versions reject "create" against a server that already has an
  // admin set; fall through to update.
  const update = await az(
    `sql server ad-admin update --resource-group ${ctx.resourceGroup} --server ${ctx.sqlServerName} --display-name "${founderUpn}" --object-id ${founderOid}`,
  );
  if (update.exitCode === 0) return;

  log.warn(
    `    SQL Entra admin set/update returned non-zero (create: ${create.exitCode}, update: ${update.exitCode}). Existing admin may differ from current deployer.`,
  );
}

/**
 * Run the CREATE USER DDL via sqlcmd with an Entra access token.
 *
 * Token is passed via environment variable so it doesn't appear on the
 * command line (procfs visibility, shell history). go-sqlcmd reads
 * `SQLCMDPASSWORD` for `--authentication-method=ActiveDirectoryAccessToken`
 * mode. The DDL is written to a temp file (mode 0600) and consumed via
 * `-i`; cleanup happens in `finally`.
 *
 * Note: this requires go-sqlcmd (the Microsoft "sqlcmd" apt package),
 * not the older mssql-tools18 sqlcmd which has neither the
 * `--authentication-method` flag nor SQLCMDPASSWORD-as-access-token
 * support. The orca-installer Dockerfile installs the `sqlcmd` package
 * for this reason.
 *
 * Returns true if sqlcmd exited 0; false (with logs) on any failure.
 */
async function runEntraDdl(ctx: DeployContext, token: string): Promise<boolean> {
  // Verify sqlcmd is available before we write anything to disk.
  const which = await execaCommand('which sqlcmd', { shell: true, reject: false });
  if (which.exitCode !== 0 || !which.stdout.trim()) {
    log.warn('    sqlcmd not on PATH — skipping; install mssql-tools or use the manual fallback below.');
    return false;
  }

  const ddlPath = path.join(os.tmpdir(), `orca-sql-entra-grant-${Date.now()}.sql`);
  try {
    fs.writeFileSync(ddlPath, entraUserDdl(ctx.miName!), { mode: 0o600 });

    const cmd =
      `sqlcmd -S ${ctx.sqlServerFqdn} -d ${SQL_PII_VAULT_DB} ` +
      `--authentication-method=ActiveDirectoryAccessToken ` +
      `-i ${ddlPath} -b`;

    const result = await execaCommand(cmd, {
      shell: true,
      timeout: 60_000,
      reject: false,
      env: { ...process.env, SQLCMDPASSWORD: token },
    });

    if (result.exitCode === 0) {
      // Surface whichever PRINT branch fired so logs reflect what happened.
      const out = (result.stdout || '').trim();
      if (out) log.dim(`    sqlcmd: ${out.split('\n').slice(-1)[0]}`);
      return true;
    }

    const tail = (result.stderr || result.stdout || '')
      .split('\n')
      .filter((l) => l.trim())
      .slice(-3)
      .join(' | ');
    log.warn(`    sqlcmd exit=${result.exitCode}: ${tail}`);
    return false;
  } catch (err: any) {
    log.warn(`    sqlcmd threw: ${err.message}`);
    return false;
  } finally {
    try {
      fs.unlinkSync(ddlPath);
    } catch {
      /* swallow */
    }
  }
}

function printManualFallback(ctx: DeployContext): void {
  log.warn('    Manual fallback — run on any workstation with az login + sqlcmd:');
  log.dim('      TOKEN=$(az account get-access-token \\');
  log.dim('        --resource https://database.windows.net/ --query accessToken -o tsv)');
  log.dim(`      SQLCMDPASSWORD=$TOKEN sqlcmd -S ${ctx.sqlServerFqdn} -d ${SQL_PII_VAULT_DB} \\`);
  log.dim('        --authentication-method=ActiveDirectoryAccessToken -Q "');
  log.dim(`        IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '${ctx.miName}')`);
  log.dim('        BEGIN');
  log.dim(`          CREATE USER [${ctx.miName}] FROM EXTERNAL PROVIDER;`);
  log.dim(`          ALTER ROLE db_datareader ADD MEMBER [${ctx.miName}];`);
  log.dim(`          ALTER ROLE db_datawriter ADD MEMBER [${ctx.miName}];`);
  log.dim(`          GRANT EXECUTE ON SCHEMA::dbo TO [${ctx.miName}];`);
  log.dim('        END"');
  log.dim('    Without this, the gateway\'s first SQL operation will fail with');
  log.dim(`    "principal '${ctx.miName}' does not exist" once rc-1.0.0 ships past 1b09acd.`);
}
