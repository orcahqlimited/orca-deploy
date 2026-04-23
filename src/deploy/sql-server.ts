import type { DeployContext } from '../types.js';
import { az, azJson, azQuiet, azTsv } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import { generateAlphanumericPassword } from '../utils/password.js';
import * as log from '../utils/log.js';

// INTENT-ORCAHQ-104 §104-A — createSqlServer.
//
// Provisions an Azure SQL server + orca-pii-vault Basic DB (2 GB) in the
// customer's resource group. Stores the admin credentials in Key Vault,
// binds the connection string as a secretRef on the gateway later in the
// deploy, applies the envelope-encryption schema DDL (pii_tokens table),
// and opens the server firewall to Azure services so the customer's
// Container Apps can reach it.
//
// Idempotent — every step checks existence first:
//   - `az sql server create` fails if the server exists, so we show-then-create.
//   - `az sql db create` fails if the DB exists, so we show-then-create.
//   - `az sql server firewall-rule create` is idempotent on names.
//   - `az keyvault secret set` overwrites existing versions.
//
// DDL is applied via Invoke-SqlCmd only if pwsh is available. If it isn't
// (Windows + PowerShell missing, or a minimal runner), the installer logs
// the DDL path so an operator can run it once post-install. The DDL itself
// is committed to this repo under `scripts/sql/pii-vault-ddl.sql`.

const PII_VAULT_DDL = `-- ORCA PII Vault — INTENT-017 envelope-encryption token store.
-- Auto-applied by orca-deploy createSqlServer().
-- Schema matches the orca-mcp-gateway src/pii/vault.mjs expectations.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'pii_tokens')
BEGIN
    CREATE TABLE dbo.pii_tokens (
        token           NVARCHAR(64)    NOT NULL PRIMARY KEY,
        kind            NVARCHAR(32)    NOT NULL,
        encrypted_value NVARCHAR(MAX)   NOT NULL,
        wrapped_dek     NVARCHAR(MAX)   NOT NULL,
        iv              NVARCHAR(64)    NOT NULL,
        auth_tag        NVARCHAR(64)    NOT NULL,
        customer_slug   NVARCHAR(32)    NOT NULL,
        created_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
        INDEX IX_pii_tokens_customer_kind NONCLUSTERED (customer_slug, kind)
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'knowledge_equity_events')
BEGIN
    CREATE TABLE dbo.knowledge_equity_events (
        event_id        UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        user_oid        NVARCHAR(64)    NOT NULL,
        customer_slug   NVARCHAR(32)    NOT NULL,
        event_type      NVARCHAR(32)    NOT NULL,
        points          INT             NOT NULL,
        ref_point_id    NVARCHAR(128)   NULL,
        created_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
        INDEX IX_ke_events_user NONCLUSTERED (user_oid),
        INDEX IX_ke_events_customer NONCLUSTERED (customer_slug, created_at)
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'knowledge_equity_balances')
BEGIN
    CREATE TABLE dbo.knowledge_equity_balances (
        user_oid        NVARCHAR(64)    NOT NULL PRIMARY KEY,
        customer_slug   NVARCHAR(32)    NOT NULL,
        balance         INT             NOT NULL DEFAULT 0,
        updated_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME()
    );
END;
`;

export async function createSqlServer(ctx: DeployContext): Promise<void> {
  const serverName = naming.sqlServerName(ctx.customerSlug, ctx.region);
  const dbName = naming.SQL_PII_VAULT_DB;
  const adminUser = 'orcadmin';
  const s = log.spinner(`Azure SQL: ${serverName} + DB ${dbName}`);

  ctx.sqlServerName = serverName;
  ctx.sqlAdminUser = adminUser;

  // Provision or reuse the server. `az sql server show` returns exit 3
  // (not 1) when not found, so we check for missing explicitly.
  let adminPassword: string | null = null;
  const existing = await az(`sql server show --name ${serverName} --resource-group ${ctx.resourceGroup}`);
  if (existing.exitCode !== 0) {
    adminPassword = generateAlphanumericPassword(24);
    await azQuiet(
      `sql server create --name ${serverName} --resource-group ${ctx.resourceGroup} --location ${ctx.region} --admin-user ${adminUser} --admin-password "${adminPassword}"`,
    );
  } else {
    // Server exists — rotate the admin password only if we haven't yet
    // stored one in KV. The orca-pii-vault connection string is the source
    // of truth; if it's absent, we regenerate + reset.
    const hasConn = await az(`keyvault secret show --vault-name ${ctx.keyVaultName} --name sql-connection-string`);
    if (hasConn.exitCode !== 0) {
      adminPassword = generateAlphanumericPassword(24);
      await azQuiet(
        `sql server update --name ${serverName} --resource-group ${ctx.resourceGroup} --admin-password "${adminPassword}"`,
      );
    }
  }

  // Store the admin password so we can rebuild the connection string on re-run.
  if (adminPassword) {
    await azQuiet(
      `keyvault secret set --vault-name ${ctx.keyVaultName} --name sql-admin-password --value "${adminPassword}"`,
    );
  }

  ctx.sqlServerFqdn = await azTsv(
    `sql server show --name ${serverName} --resource-group ${ctx.resourceGroup} --query fullyQualifiedDomainName`,
  );

  // Firewall rule: allow Azure services (the Container Apps managed
  // identity path). Named fixed so re-runs are idempotent.
  await azQuiet(
    `sql server firewall-rule create --server ${serverName} --resource-group ${ctx.resourceGroup} --name AllowAzureServices --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0`,
  ).catch(() => {});

  // Database: Basic tier, 2 GB — enough for PII tokens + equity ledger at
  // customer scale. DTU billing is ~£3/mo.
  const dbExists = await az(
    `sql db show --server ${serverName} --resource-group ${ctx.resourceGroup} --name ${dbName}`,
  );
  if (dbExists.exitCode !== 0) {
    await azQuiet(
      `sql db create --server ${serverName} --resource-group ${ctx.resourceGroup} --name ${dbName} --service-objective Basic --collation SQL_Latin1_General_CP1_CI_AS`,
    );
  }

  // Rebuild connection string + store in KV. Using SQL auth here; the
  // gateway reads this secret at startup. On the first-run path we already
  // have the password in scope; on a resume path (server existed, no
  // adminPassword branch taken) we fall back to reading it from KV.
  let kvPassword: string;
  if (adminPassword) {
    kvPassword = adminPassword;
  } else {
    kvPassword = await azTsv(
      `keyvault secret show --vault-name ${ctx.keyVaultName} --name sql-admin-password --query value`,
    );
  }
  const connectionString = `Server=tcp:${ctx.sqlServerFqdn},1433;Initial Catalog=${dbName};Persist Security Info=False;User ID=${adminUser};Password=${kvPassword};MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;`;
  await azQuiet(
    `keyvault secret set --vault-name ${ctx.keyVaultName} --name sql-connection-string --value "${connectionString.replace(/"/g, '\\"')}"`,
  );

  // Apply DDL. Best-effort — logs a path if pwsh + Invoke-SqlCmd are not
  // available. The schema is small + idempotent, so a re-apply is safe.
  await applyDdl(ctx, serverName, dbName, adminUser, kvPassword).catch((err) => {
    s.warn(
      `  DDL apply skipped: ${err.message}. Apply manually once: scripts/sql/pii-vault-ddl.sql`,
    );
  });

  s.succeed(`  Azure SQL: ${serverName} + DB ${dbName} (Basic, connection string in KV)`);
}

async function applyDdl(
  ctx: DeployContext,
  serverName: string,
  dbName: string,
  adminUser: string,
  password: string,
): Promise<void> {
  // Write the DDL to a temp file; invoke via sqlcmd if present in PATH.
  // sqlcmd ships with Azure Data Studio / mssql-tools on Debian and is
  // preinstalled in the orca-installer image starting with v0.2.4.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execaCommand } = await import('execa');

  const ddlPath = path.join(os.tmpdir(), `orca-pii-vault-ddl-${Date.now()}.sql`);
  fs.writeFileSync(ddlPath, PII_VAULT_DDL);
  try {
    await execaCommand(
      `sqlcmd -S ${ctx.sqlServerFqdn} -d ${dbName} -U ${adminUser} -P "${password}" -i ${ddlPath} -b`,
      { shell: true, timeout: 60_000 },
    );
  } finally {
    fs.unlinkSync(ddlPath);
  }
}
