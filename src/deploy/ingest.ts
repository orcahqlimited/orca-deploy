// =============================================================================
// src/deploy/ingest.ts
// INTENT-ORCAHQ-106 — orca-deploy: optional orca-ingest install step.
//
// One additional provisioning branch glued into the linear install flow.
// Runs after health checks complete, before printSummary, so the customer
// has a working core ORCA stack before they're asked about the optional
// engagement-ingest tool.
//
// Side-effects (only if the customer says yes):
//   1. Creates the "ORCA Engagement Ingest" Entra app reg with Graph
//      Sites.Read.All (Application) permission, attempts admin consent.
//   2. Generates a client secret, stores it in customer KV as
//      ingest-graph-client-secret.
//   3. Prompts the customer for their OpenAI API key (text-embedding-3-small),
//      stores it in KV as ingest-openai-api-key.
//   4. Writes ~/orca/ingest/.env (mode 0600) populated from the values above.
//   5. Pulls ghcr.io/orcahqlimited/orca-ingest:<pinned> and verifies the pull.
//
// Graceful degradation: any single sub-step that fails surfaces a clear
// warning and lets the install complete — the engagement-ingest tool is
// optional, it should never block the core install.
//
// Attack-surface delta: one new Entra app registration with one Graph
// Application permission (Sites.Read.All), one new KV secret
// (ingest-graph-client-secret), one new KV secret (ingest-openai-api-key),
// one new file on the deployer's host at ~/orca/ingest/.env (mode 0600).
// No new Container Apps, no new public hostnames, no new outbound domains
// (the ghcr.io image registry is already a v0.2.4 dependency).
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirm, password } from '@inquirer/prompts';
import { execaCommand } from 'execa';
import type { DeployContext } from '../types.js';
import { az, azJson, azQuiet, azTsv } from '../utils/az.js';
import {
  INGEST_GHCR_REPO,
  INGEST_IMAGE_VERSION,
  INGEST_GRAPH_SITES_READ_ALL_ID,
} from '../utils/config.js';
import * as log from '../utils/log.js';
import chalk from 'chalk';

const GRAPH_RESOURCE_ID = '00000003-0000-0000-c000-000000000000';
const INGEST_APP_DISPLAY_NAME = 'ORCA Engagement Ingest';
const KV_INGEST_SECRET_NAME = 'ingest-graph-client-secret';
const KV_INGEST_OPENAI_KEY = 'ingest-openai-api-key';

export async function installIngest(ctx: DeployContext): Promise<void> {
  // 106-A — single prompt, default no.
  log.blank();
  log.heading('  Optional: Engagement-Ingest Tool');
  log.dim('  orca-ingest bulk-seeds an engagement brain from SharePoint or local files.');
  log.dim('  Selecting yes will create one Entra app reg, store one KV secret, and');
  log.dim('  pull a ~120MB Docker image. Skip if you only need the core stack.');
  log.blank();

  const yes = await confirm({
    message: 'Install the engagement-ingest tool?',
    default: false,
  });

  if (!yes) {
    log.dim('  Skipped — orca-ingest can be installed later via the runbook.');
    return;
  }

  ctx.ingestEnabled = true;
  ctx.ingestImageRef = `${INGEST_GHCR_REPO}:${INGEST_IMAGE_VERSION}`;

  // 106-D — OpenAI key prompt. Asked up-front so the customer doesn't
  // hit a second prompt halfway through provisioning.
  log.blank();
  log.dim('  orca-ingest needs an OpenAI API key for text-embedding-3-small.');
  log.dim('  This must match the embedding model the gateway uses — substituting');
  log.dim('  another model will break retrieval. Stored in your Key Vault as');
  log.dim(`  ${KV_INGEST_OPENAI_KEY}.`);
  const openaiKey = await password({
    message: 'OpenAI API key (sk-...):',
    mask: '*',
  });

  if (!openaiKey || !openaiKey.trim()) {
    log.warn('  Empty OpenAI key — skipping ingest install.');
    ctx.ingestEnabled = false;
    return;
  }

  // Step 1 — Entra app reg + Graph Sites.Read.All + admin consent.
  await provisionIngestEntraApp(ctx);
  if (!ctx.ingestEntraAppId) {
    log.warn('  Skipping remaining ingest steps — Entra app reg missing.');
    ctx.ingestEnabled = false;
    return;
  }

  // Step 2 — store OpenAI key in KV (after the app reg succeeded so we
  // don't litter KV with secrets for a half-provisioned tool).
  await storeOpenAiKey(ctx, openaiKey.trim());

  // Step 3 — write ~/orca/ingest/.env (mode 0600).
  await writeIngestEnvFile(ctx, openaiKey.trim());

  // Step 4 — pull the pinned image, verify the digest is materialised.
  await pullIngestImage(ctx);
}

// -----------------------------------------------------------------------------
// 106-B — Entra app registration + Graph permission + admin-consent
// -----------------------------------------------------------------------------

async function provisionIngestEntraApp(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Engagement Ingest: Entra app registration');

  // Idempotent: reuse existing app if present (re-runs of orca-deploy must
  // not duplicate-create).
  let appId: string | null = null;
  try {
    const existing = await azJson<{ appId?: string } | null>(
      `ad app list --display-name "${INGEST_APP_DISPLAY_NAME}" --query "[0].{appId:appId}"`,
    );
    if (existing && existing.appId) {
      appId = existing.appId;
    }
  } catch {
    /* no existing app — create one */
  }

  if (!appId) {
    try {
      const created = await azJson<{ appId: string }>(
        `ad app create --display-name "${INGEST_APP_DISPLAY_NAME}" ` +
          `--sign-in-audience AzureADMyOrg --query "{appId:appId}"`,
      );
      appId = created.appId;
      // Service principal — required before admin-consent or role assignment.
      await azQuiet(`ad sp create --id ${appId}`).catch(() => {
        /* may already exist — ignore */
      });
    } catch (err: any) {
      s.fail('  Engagement Ingest: Entra app create failed');
      log.warn(`    ${err.message}`);
      return;
    }
  }

  ctx.ingestEntraAppId = appId;
  ctx.ingestEntraClientId = appId;

  // Add Graph Sites.Read.All (Application) — idempotent at the CLI level.
  try {
    await azQuiet(
      `ad app permission add --id ${appId} ` +
        `--api ${GRAPH_RESOURCE_ID} ` +
        `--api-permissions ${INGEST_GRAPH_SITES_READ_ALL_ID}=Role`,
    );
  } catch (err: any) {
    s.warn('  Engagement Ingest: Graph permission add failed — continuing');
    log.warn(`    ${err.message}`);
  }

  // Generate a client secret and store in customer KV (106-C).
  let secret: string | null = null;
  try {
    const cred = await azJson<{ password: string }>(
      `ad app credential reset --id ${appId} ` +
        `--display-name "orca-ingest" --years 1 --append --query "{password:password}"`,
    );
    secret = cred.password;
  } catch (err: any) {
    s.fail('  Engagement Ingest: client secret generation failed');
    log.warn(`    ${err.message}`);
    return;
  }

  try {
    await azQuiet(
      `keyvault secret set --vault-name ${ctx.keyVaultName} ` +
        `--name ${KV_INGEST_SECRET_NAME} --value "${secret.replace(/"/g, '\\"')}"`,
    );
  } catch (err: any) {
    s.fail('  Engagement Ingest: KV secret store failed');
    log.warn(`    ${err.message}`);
    return;
  }

  // Verify-after-write — same shape as configureFoundry (CL-ORCAHQ-0103).
  try {
    const readback = await azTsv(
      `keyvault secret show --vault-name ${ctx.keyVaultName} --name ${KV_INGEST_SECRET_NAME} --query value`,
    );
    if (readback !== secret) {
      s.warn('  Engagement Ingest: KV read-back mismatch — secret may be truncated');
    }
  } catch {
    /* read-back failure is diagnostic only */
  }

  // Admin consent — must NOT silently skip per 106-B.
  const consent = await az(`ad app permission admin-consent --id ${appId}`);
  if (consent.exitCode === 0) {
    s.succeed(
      '  Engagement Ingest: Entra app reg + Graph Sites.Read.All (admin-consented), KV secret stored',
    );
  } else {
    ctx.ingestConsentPending = true;
    s.warn(
      '  Engagement Ingest: Entra app reg created — admin consent is PENDING',
    );
    log.warn(
      "    Graph Sites.Read.All needs Global Admin consent before orca-ingest's",
    );
    log.warn('    SharePoint source can read sites. Have a Global Admin run:');
    log.dim(`      az ad app permission admin-consent --id ${appId}`);
    log.dim(
      '    Or consent via the Azure Portal: Entra ID → App registrations → ' +
        `${INGEST_APP_DISPLAY_NAME} → API permissions → Grant admin consent.`,
    );
  }
}

// -----------------------------------------------------------------------------
// 106-C / 106-D — store the OpenAI key (so the .env file can reference it later
// from KV in HQ-led seeds, and so the customer can rotate without rewriting
// the .env). The .env still gets the literal value — orca-ingest reads
// straight from env, no KV client.
// -----------------------------------------------------------------------------

async function storeOpenAiKey(ctx: DeployContext, openaiKey: string): Promise<void> {
  const s = log.spinner('Engagement Ingest: storing OpenAI key in Key Vault');
  try {
    await azQuiet(
      `keyvault secret set --vault-name ${ctx.keyVaultName} ` +
        `--name ${KV_INGEST_OPENAI_KEY} --value "${openaiKey.replace(/"/g, '\\"')}"`,
    );
    s.succeed(
      `  Engagement Ingest: OpenAI key stored as ${KV_INGEST_OPENAI_KEY}`,
    );
  } catch (err: any) {
    s.warn('  Engagement Ingest: KV write for OpenAI key failed — continuing');
    log.warn(`    ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// 106-D — write ~/orca/ingest/.env (mode 0600).
// Contains the literal client secret + OpenAI key. Customers running this on
// a shared workstation should consider regenerating both after their first
// seed run; the ledger of seeded items lives in ./data, not in this file.
// -----------------------------------------------------------------------------

async function writeIngestEnvFile(ctx: DeployContext, openaiKey: string): Promise<void> {
  const s = log.spinner('Engagement Ingest: writing ~/orca/ingest/.env');

  if (!ctx.ingestEntraAppId) {
    s.warn('  Engagement Ingest: no Entra app — skipping .env');
    return;
  }

  // Pull the secret back from KV — we never kept it in process memory after
  // the credential-reset call, on purpose (one fewer place to leak from).
  let clientSecret: string;
  try {
    clientSecret = await azTsv(
      `keyvault secret show --vault-name ${ctx.keyVaultName} ` +
        `--name ${KV_INGEST_SECRET_NAME} --query value`,
    );
  } catch (err: any) {
    s.warn('  Engagement Ingest: could not read client secret back from KV');
    log.warn(`    ${err.message}`);
    return;
  }

  // QDRANT_URL — orca-ingest expects to talk straight to Qdrant. For
  // customer deploys with AKS we have ctx.qdrantInternalUrl; for connector-
  // only deploys leave it as a placeholder for the customer to fill in
  // (orca-ingest is not useful without Qdrant anyway).
  const qdrantUrl = ctx.qdrantInternalUrl || '<set-to-your-qdrant-url>';

  const ingestDir = path.join(os.homedir(), 'orca', 'ingest');
  const envPath = path.join(ingestDir, '.env');

  try {
    fs.mkdirSync(ingestDir, { recursive: true, mode: 0o700 });
  } catch (err: any) {
    s.warn(`  Engagement Ingest: could not create ${ingestDir}: ${err.message}`);
    return;
  }

  const lines = [
    '# orca-ingest — written by orca-deploy (INTENT-106).',
    '# Mode 0600 — contains a Graph client secret and an OpenAI API key.',
    '# Both secrets are also in your Key Vault — rotate there if compromised.',
    '',
    '# Qdrant — your ORCA instance',
    `QDRANT_URL=${qdrantUrl}`,
    'QDRANT_API_KEY=',
    '',
    '# OpenAI embeddings — text-embedding-3-small (1536d). Do not change.',
    `OPENAI_API_KEY=${openaiKey}`,
    '',
    '# SharePoint (only if --source sharepoint)',
    `AZURE_TENANT_ID=${ctx.tenantId}`,
    `AZURE_CLIENT_ID=${ctx.ingestEntraAppId}`,
    `AZURE_CLIENT_SECRET=${clientSecret}`,
    '',
    '# Ledger — persisted to the mounted volume',
    'LEDGER_PATH=/data/ingest-ledger.db',
    '',
  ].join('\n');

  try {
    fs.writeFileSync(envPath, lines, { mode: 0o600 });
    // Belt + braces: chmod after write in case mode wasn't honoured by umask.
    fs.chmodSync(envPath, 0o600);
    ctx.ingestEnvFilePath = envPath;
    s.succeed(`  Engagement Ingest: wrote ${envPath} (mode 0600)`);
  } catch (err: any) {
    s.warn(`  Engagement Ingest: write ${envPath} failed: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// 106-E — pull + verify the pinned image.
// We use docker pull rather than docker run --pull because the pull failure
// mode is what we care about; orca-ingest needs --customer flags to run, and
// running it here would either error on missing args or attempt a real seed.
// -----------------------------------------------------------------------------

async function pullIngestImage(ctx: DeployContext): Promise<void> {
  const ref = `${INGEST_GHCR_REPO}:${INGEST_IMAGE_VERSION}`;
  const s = log.spinner(`Engagement Ingest: pulling ${ref}`);

  // Is docker even available? The installer container itself ships docker,
  // but customers running outside it may not — surface a clear message.
  const which = await execaCommand('which docker', { shell: true, reject: false });
  if (which.exitCode !== 0 || !which.stdout.trim()) {
    s.warn('  Engagement Ingest: docker not found on PATH — skipping pull');
    log.dim(`    Run on the host that will execute the seed:  docker pull ${ref}`);
    return;
  }

  const pull = await execaCommand(`docker pull ${ref}`, {
    shell: true,
    reject: false,
    timeout: 300_000,
  });
  if (pull.exitCode !== 0) {
    s.warn(
      `  Engagement Ingest: docker pull ${ref} failed — image may be private or network blocked`,
    );
    log.dim(`    ${(pull.stderr || pull.stdout || '').split('\n').slice(-3).join(' | ')}`);
    return;
  }

  // Verify the pulled image is materialised in the local docker store.
  const inspect = await execaCommand(`docker image inspect ${ref}`, {
    shell: true,
    reject: false,
  });
  if (inspect.exitCode !== 0) {
    s.warn(
      `  Engagement Ingest: docker pull reported success but ${ref} not in local store`,
    );
    return;
  }

  s.succeed(`  Engagement Ingest: image ${ref} pulled + verified`);
}

// -----------------------------------------------------------------------------
// 106-F — print the ready-to-run seed command in the install summary.
// Called from health.ts:printSummary if ctx.ingestEnabled is true.
// -----------------------------------------------------------------------------

export function printIngestSummary(ctx: DeployContext): void {
  if (!ctx.ingestEnabled) return;

  log.blank();
  log.divider();
  console.log(chalk.white.bold('  Engagement-Ingest Tool — Ready to Seed'));
  log.divider();

  if (ctx.ingestEntraAppId) {
    console.log(`  Entra App ID:      ${chalk.white(ctx.ingestEntraAppId)}`);
    console.log(`  KV Secret:         ${chalk.white(KV_INGEST_SECRET_NAME)}`);
    console.log(`  OpenAI Key (KV):   ${chalk.white(KV_INGEST_OPENAI_KEY)}`);
  }
  if (ctx.ingestEnvFilePath) {
    console.log(`  .env File:         ${chalk.white(ctx.ingestEnvFilePath)} (mode 0600)`);
  }
  if (ctx.ingestImageRef) {
    console.log(`  Image:             ${chalk.white(ctx.ingestImageRef)}`);
  }

  if (ctx.ingestConsentPending) {
    log.blank();
    console.log(
      chalk.yellow(
        '  ⚠ Graph Sites.Read.All admin consent PENDING — a Global Admin must run:',
      ),
    );
    console.log(
      chalk.dim(
        `    az ad app permission admin-consent --id ${ctx.ingestEntraAppId}`,
      ),
    );
  }

  log.blank();
  console.log(chalk.dim('  Dry-run your first SharePoint seed:'));
  console.log(chalk.cyan(`    docker run --rm -it \\`));
  console.log(chalk.cyan(`      --env-file ${ctx.ingestEnvFilePath || '~/orca/ingest/.env'} \\`));
  console.log(chalk.cyan(`      -v "$(pwd)/data:/data" \\`));
  console.log(chalk.cyan(`      ${ctx.ingestImageRef || INGEST_GHCR_REPO + ':' + INGEST_IMAGE_VERSION} \\`));
  console.log(chalk.cyan(`      --customer "${ctx.customerSlug}" \\`));
  console.log(chalk.cyan(`      --customer-short ${ctx.customerSlug} \\`));
  console.log(chalk.cyan(`      --source sharepoint \\`));
  console.log(chalk.cyan(`      --sharepoint-site <your-tenant>.sharepoint.com/sites/<your-site> \\`));
  console.log(chalk.cyan(`      --phase 1 --dry-run`));
  log.blank();
  console.log(
    chalk.dim(
      '  Drop --dry-run for the real seed. Runbook: ORCAHQ-ENGAGEMENT-INGEST-OPS-001.md',
    ),
  );
}
