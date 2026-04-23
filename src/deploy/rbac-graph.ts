// =============================================================================
// src/deploy/rbac-graph.ts
// ORCA meeting capture — tenant-side prerequisites.
//
// Four idempotent steps:
//   1. createEligibilityGroup()      — Entra group gating personal-brain issue
//   2. addGraphPermissions()         — extend ORCA Entra app with Graph roles
//   3. createGraphSubscription()     — Graph subscription for transcript notifications
//   4. grantApplicationAccessPolicy()— Teams CsApplicationAccessPolicy + grant
//
// CRITICAL: all HTTP is raw node:https (CL-2026-0070 — fetch() fails silently in
// Azure Container Apps; same rule applies to every ORCA tool). Azure CLI calls
// go through execa via the existing az.ts helpers.
// =============================================================================

import https from 'node:https';
import crypto from 'node:crypto';
import { execaCommand } from 'execa';
import type { DeployContext } from '../types.js';
import { az, azJson, azQuiet, azTsv } from '../utils/az.js';
import * as log from '../utils/log.js';
import { GRAPH_APP_PERMISSIONS } from './entra.js';

// ---------- Shared helpers ----------

const GRAPH_RESOURCE_ID = '00000003-0000-0000-c000-000000000000';

interface GraphResponse {
  statusCode: number;
  body: string;
}

/**
 * Raw HTTPS request helper. Used for both the token endpoint and Graph itself.
 * NEVER replace with fetch() — see CL-2026-0070.
 */
function httpsRequest(
  hostname: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<GraphResponse> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname,
      port: 443,
      path,
      method,
      headers: { ...headers },
      timeout: 30000,
    };

    if (body) {
      (options.headers as Record<string, string>)['Content-Length'] =
        String(Buffer.byteLength(body));
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body: data });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTPS request timeout (30s) to ${hostname}${path}`));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Acquire a Microsoft Graph application token via client_credentials flow.
 */
async function getGraphAppToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body =
    'grant_type=client_credentials' +
    '&client_id=' + encodeURIComponent(clientId) +
    '&client_secret=' + encodeURIComponent(clientSecret) +
    '&scope=' + encodeURIComponent('https://graph.microsoft.com/.default');

  const res = await httpsRequest(
    'login.microsoftonline.com',
    '/' + encodeURIComponent(tenantId) + '/oauth2/v2.0/token',
    'POST',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Graph token request failed (${res.statusCode}): ${res.body.substring(0, 400)}`);
  }

  const parsed = JSON.parse(res.body);
  if (!parsed.access_token) {
    throw new Error(`Graph token response missing access_token: ${res.body.substring(0, 200)}`);
  }
  return parsed.access_token as string;
}

// =============================================================================
// 1. ORCA-Eligible Entra group
// =============================================================================

/**
 * Create (or reuse) the ORCA-Eligible Entra security group and add the Founder.
 * Only users in this group receive a personal brain from meeting capture.
 */
export async function createEligibilityGroup(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Entra Group: ORCA-Eligible (meeting-capture gate)');

  // Resolve founder OID from the signed-in az session if not already known.
  if (!ctx.founderOid) {
    try {
      ctx.founderOid = await azTsv(`ad signed-in-user show --query id`);
    } catch (err: any) {
      s.fail('  Entra Group: ORCA-Eligible — could not resolve signed-in user OID');
      log.warn(`    ${err.message}`);
      return;
    }
  }

  // Idempotent: reuse existing group if present.
  try {
    const existing = await azJson<{ id?: string } | null>(
      `ad group list --display-name "ORCA-Eligible" --query "[0].{id:id}"`,
    );
    if (existing && existing.id) {
      ctx.eligibilityGroupOid = existing.id;
      await ensureFounderInGroup(existing.id, ctx.founderOid);
      s.succeed('  Entra Group: ORCA-Eligible (existing — founder ensured as member)');
      return;
    }
  } catch { /* fall through — create */ }

  try {
    const created = await azJson<{ id: string }>(
      `ad group create --display-name "ORCA-Eligible" ` +
      `--mail-nickname "orca-eligible" ` +
      `--description "Users who receive personal brains from meeting capture. ` +
      `Members-only — no personal brain without being in this group." ` +
      `--query "{id:id}"`,
    );
    ctx.eligibilityGroupOid = created.id;

    await ensureFounderInGroup(created.id, ctx.founderOid);

    s.succeed('  Entra Group: ORCA-Eligible (created — founder added)');
  } catch (err: any) {
    s.fail('  Entra Group: ORCA-Eligible — create failed');
    log.warn(`    ${err.message}`);
  }
}

async function ensureFounderInGroup(groupOid: string, founderOid: string): Promise<void> {
  // `az ad group member add` errors if the member already exists — swallow that.
  const result = await az(`ad group member add --group ${groupOid} --member-id ${founderOid}`);
  if (result.exitCode !== 0) {
    const already = /already exist|already a member|One or more added object references already exist/i
      .test(result.stderr);
    if (!already) {
      // Surface the error but do not fail the step — the group itself exists.
      log.warn(`    Could not add founder to ORCA-Eligible: ${result.stderr.trim().split('\n')[0]}`);
    }
  }
}

// =============================================================================
// 2. Graph application permissions on the ORCA Entra app
// =============================================================================

/**
 * Add the Graph application (Role) permissions required for meeting capture to
 * the ORCA Intelligence Connectors Entra app, then attempt admin consent.
 *
 * If admin consent fails (the deployer is not a Global Admin on the customer
 * tenant), we log the exact command the customer's Global Admin must run and
 * continue — per spec, consent failure must NOT block the deploy.
 */
export async function addGraphPermissions(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Entra App: Graph permissions for meeting capture');

  if (!ctx.entraAppId) {
    s.fail('  Entra App: Graph permissions — no entraAppId on context');
    return;
  }

  try {
    for (const perm of GRAPH_APP_PERMISSIONS) {
      await azQuiet(
        `ad app permission add --id ${ctx.entraAppId} ` +
        `--api ${GRAPH_RESOURCE_ID} ` +
        `--api-permissions ${perm.id}=Role`,
      );
    }
  } catch (err: any) {
    s.fail('  Entra App: Graph permissions — add failed');
    log.warn(`    ${err.message}`);
    return;
  }

  // Admin consent. Requires Global Admin on the tenant.
  const consent = await az(`ad app permission admin-consent --id ${ctx.entraAppId}`);
  if (consent.exitCode === 0) {
    s.succeed(`  Entra App: Graph permissions (${GRAPH_APP_PERMISSIONS.length} roles, admin-consented)`);
  } else {
    s.warn(`  Entra App: Graph permissions (${GRAPH_APP_PERMISSIONS.length} roles added — admin consent pending)`);
    log.warn('    Admin consent failed — the customer\'s Global Admin must run:');
    log.dim(`      az ad app permission admin-consent --id ${ctx.entraAppId}`);
    log.dim('    Or grant via the Azure Portal: Entra ID → App registrations → ORCA Intelligence Connectors → API permissions → Grant admin consent.');
  }
}

// =============================================================================
// 3. Graph change-notification subscription
// =============================================================================

/**
 * Create a Graph subscription against communications/onlineMeetings/getAllTranscripts
 * pointing at the customer gateway's /webhooks/graph/meeting-completed endpoint.
 *
 * Must run AFTER the gateway Container App has a public FQDN — ctx.gatewayUrl is required.
 * Admin consent on the Graph permissions must already be in place, otherwise the
 * client_credentials flow will fail to yield a usable token.
 */
export async function createGraphSubscription(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Graph subscription: onlineMeetings/getAllTranscripts');

  if (!ctx.gatewayUrl) {
    s.warn('  Graph subscription — skipped (no gatewayUrl on context)');
    return;
  }
  if (!ctx.entraAppId || !ctx.entraClientSecret) {
    s.warn('  Graph subscription — skipped (entra app id / secret missing)');
    return;
  }

  // Generate + persist clientState (32 hex chars). Re-use the existing one if
  // it is already in Key Vault so the gateway does not start rejecting events.
  let clientState: string;
  try {
    clientState = await azTsv(
      `keyvault secret show --vault-name ${ctx.keyVaultName} ` +
      `--name graph-subscription-client-state --query value`,
    );
  } catch {
    clientState = crypto.randomBytes(16).toString('hex');
    try {
      await azQuiet(
        `keyvault secret set --vault-name ${ctx.keyVaultName} ` +
        `--name graph-subscription-client-state --value "${clientState}"`,
      );
    } catch (err: any) {
      s.fail('  Graph subscription — could not persist client state to Key Vault');
      log.warn(`    ${err.message}`);
      return;
    }
  }
  ctx.graphClientState = clientState;

  // Acquire a Graph token (client_credentials).
  let token: string;
  try {
    token = await getGraphAppToken(ctx.tenantId, ctx.entraAppId, ctx.entraClientSecret);
  } catch (err: any) {
    s.warn('  Graph subscription — token acquisition failed (admin consent likely pending)');
    log.dim(`    ${err.message}`);
    log.dim('    The subscription will be re-created automatically by the gateway\'s renewal loop once consent is granted.');
    return;
  }

  const notificationUrl = `${ctx.gatewayUrl.replace(/\/+$/, '')}/webhooks/graph/meeting-completed`;

  // Idempotent: look for an existing subscription to the same resource+url.
  try {
    const listRes = await httpsRequest(
      'graph.microsoft.com',
      '/v1.0/subscriptions',
      'GET',
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    );

    if (listRes.statusCode >= 200 && listRes.statusCode < 300) {
      const parsed = JSON.parse(listRes.body);
      const existing = Array.isArray(parsed.value)
        ? parsed.value.find((sub: any) =>
            sub.resource === 'communications/onlineMeetings/getAllTranscripts' &&
            sub.notificationUrl === notificationUrl)
        : null;

      if (existing && existing.id) {
        ctx.graphSubscriptionId = existing.id;
        s.succeed(`  Graph subscription (existing — ${existing.id})`);
        return;
      }
    }
  } catch { /* fall through and try to create */ }

  // Create a new subscription.
  const body = JSON.stringify({
    changeType: 'created',
    notificationUrl,
    resource: 'communications/onlineMeetings/getAllTranscripts',
    expirationDateTime: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    clientState,
    lifecycleNotificationUrl: notificationUrl,
  });

  const res = await httpsRequest(
    'graph.microsoft.com',
    '/v1.0/subscriptions',
    'POST',
    {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
  );

  if (res.statusCode >= 200 && res.statusCode < 300) {
    const created = JSON.parse(res.body);
    ctx.graphSubscriptionId = created.id;
    s.succeed(`  Graph subscription (created — ${created.id})`);
  } else {
    s.warn('  Graph subscription — create failed');
    log.dim(`    HTTP ${res.statusCode}: ${res.body.substring(0, 400)}`);
    log.dim('    The gateway\'s renewal scheduler will attempt creation again once it starts.');
  }
}

// =============================================================================
// 4. Teams CsApplicationAccessPolicy
// =============================================================================

/**
 * Create + grant the Teams application access policy that allows the ORCA app
 * to read online meetings and transcripts for policy members.
 *
 * Depends on the MicrosoftTeams PowerShell module. If pwsh is not installed we
 * print the exact commands the customer must run on any admin workstation.
 */
export async function grantApplicationAccessPolicy(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Teams CsApplicationAccessPolicy: ORCAMeetingCapture');

  if (!ctx.entraAppId) {
    s.fail('  Teams access policy — no entraAppId on context');
    return;
  }
  if (!ctx.founderOid) {
    try {
      ctx.founderOid = await azTsv(`ad signed-in-user show --query id`);
    } catch (err: any) {
      s.fail('  Teams access policy — could not resolve founder OID');
      log.warn(`    ${err.message}`);
      return;
    }
  }

  // Is pwsh available?
  const pwshCheck = await execaCommand('which pwsh', { shell: true, reject: false });
  const pwshAvailable = pwshCheck.exitCode === 0 && pwshCheck.stdout.trim().length > 0;

  if (!pwshAvailable) {
    s.warn('  Teams access policy — PowerShell (pwsh) not installed, manual step required');
    log.blank();
    log.info('Run these commands on any workstation with the MicrosoftTeams module:');
    printAccessPolicyManualCommands(ctx.tenantId, ctx.entraAppId, ctx.founderOid);
    return;
  }

  // Script: create policy if missing, grant to founder.
  // New-CsApplicationAccessPolicy errors if the policy already exists — swallow.
  // Grant-CsApplicationAccessPolicy is idempotent.
  const psScript = [
    `$ErrorActionPreference = 'Stop'`,
    `Import-Module MicrosoftTeams -ErrorAction Stop`,
    `Connect-MicrosoftTeams -TenantId ${ctx.tenantId} | Out-Null`,
    `try {`,
    `  New-CsApplicationAccessPolicy -Identity "ORCAMeetingCapture" ` +
      `-AppIds "${ctx.entraAppId}" ` +
      `-Description "ORCA meeting transcript access" | Out-Null`,
    `  Write-Output "policy_created"`,
    `} catch {`,
    `  if ($_.Exception.Message -match 'already exists') {`,
    `    Write-Output "policy_exists"`,
    `  } else { throw }`,
    `}`,
    `Grant-CsApplicationAccessPolicy -Identity ${ctx.founderOid} ` +
      `-PolicyName "ORCAMeetingCapture" | Out-Null`,
    `Write-Output "policy_granted"`,
  ].join('; ');

  const result = await execaCommand(`pwsh -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
    shell: true,
    reject: false,
    timeout: 180_000,
  });

  if (result.exitCode === 0) {
    const created = /policy_created/.test(result.stdout);
    s.succeed(
      created
        ? '  Teams access policy: ORCAMeetingCapture (created + granted to founder)'
        : '  Teams access policy: ORCAMeetingCapture (existing — granted to founder)',
    );
  } else {
    s.warn('  Teams access policy — PowerShell step failed, manual fallback required');
    log.dim(`    ${(result.stderr || result.stdout || '').split('\n')[0]}`);
    log.blank();
    log.info('Run these commands on any workstation with the MicrosoftTeams module:');
    printAccessPolicyManualCommands(ctx.tenantId, ctx.entraAppId, ctx.founderOid);
  }
}

function printAccessPolicyManualCommands(tenantId: string, appId: string, founderOid: string): void {
  log.dim(`      Connect-MicrosoftTeams -TenantId ${tenantId}`);
  log.dim(`      New-CsApplicationAccessPolicy -Identity "ORCAMeetingCapture" \\`);
  log.dim(`        -AppIds "${appId}" \\`);
  log.dim(`        -Description "ORCA meeting transcript access"`);
  log.dim(`      Grant-CsApplicationAccessPolicy -Identity ${founderOid} \\`);
  log.dim(`        -PolicyName "ORCAMeetingCapture"`);
  log.blank();
}

// =============================================================================
// 5. Assign deployer to ORCA.Founder on the Entra app SP (INTENT-104 §104-G)
// =============================================================================

// The ORCA.Founder role ID — matches ENTRA_APP_ROLES in src/utils/config.ts.
// Kept in sync manually; the value is a stable UUID, not customer-specific.
const ORCA_FOUNDER_ROLE_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/**
 * Assign the signed-in deployer to ORCA.Founder on the Entra app's service
 * principal. Without this assignment every authenticated request from the
 * Founder arrives with an empty `roles` claim and the gateway returns 403 —
 * exactly the 11-hour surprise from the AgileCadence install (CL-ORCAHQ-0106).
 *
 * Idempotent: if the assignment already exists Graph returns 400 with error
 * code "Request_BadRequest" + message containing "already exists"; we catch
 * that and treat it as success.
 */
export async function assignDeployerFounderRole(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Assigning ORCA.Founder role to deployer');

  if (!ctx.entraAppId) {
    s.warn('  Founder role assignment: entraAppId missing — skipped');
    return;
  }

  try {
    // Resolve the ORCA MCP Gateway service principal id (not the appId — the
    // /appRoleAssignedTo endpoint wants the SP object id).
    const spId = await azTsv(
      `ad sp show --id ${ctx.entraAppId} --query id`,
    );
    const deployerOid = ctx.founderOid
      ?? (ctx.founderOid = await azTsv('ad signed-in-user show --query id'));

    const body = JSON.stringify({
      principalId: deployerOid,
      resourceId: spId,
      appRoleId: ORCA_FOUNDER_ROLE_ID,
    }).replace(/"/g, '\\"');

    const result = await az(
      `rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo" --headers "Content-Type=application/json" --body "${body}"`,
    );

    if (result.exitCode === 0) {
      s.succeed('  ORCA.Founder role assigned to deployer');
      return;
    }

    // Already-assigned detection — Graph returns 400 with "already exists"
    // or a duplicate-permissions message. Both are success from our POV.
    const err = (result.stderr || '').toLowerCase();
    if (err.includes('already exists') || err.includes('permission being assigned')) {
      s.succeed('  ORCA.Founder role already assigned to deployer');
      return;
    }

    s.warn('  ORCA.Founder role assignment failed — manual step required');
    log.dim(`    ${(result.stderr || '').split('\n')[0]}`);
    log.dim(`    az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo" \\`);
    log.dim(`      --body '${JSON.stringify({ principalId: deployerOid, resourceId: spId, appRoleId: ORCA_FOUNDER_ROLE_ID })}'`);
  } catch (err: any) {
    s.warn(`  ORCA.Founder role assignment error: ${err.message}`);
  }
}
