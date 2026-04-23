import { execaCommand } from 'execa';
import { confirm } from '@inquirer/prompts';
import * as log from '../utils/log.js';

// INTENT-ORCAHQ-104 §104-O — container-owned az login.
//
// Before this change the installer required the customer to mount their
// host `~/.azure` directory into the container. That failed in three
// specific ways during the AgileCadence install:
//   CL-ORCAHQ-0115 — host path unreadable on Windows because Docker Desktop
//                    was configured for WSL file sharing only.
//   CL-ORCAHQ-0116 — stale session on the host; the container saw the
//                    profile but the refresh token was expired.
//   CL-ORCAHQ-0117 — host had multi-tenant profile, container picked the
//                    wrong default tenant.
//
// The container now owns its own Azure CLI session. First run: no session
// present, installer runs `az login --use-device-code` directly. The output
// (code + URL) is streamed to the parent terminal so the customer can
// authenticate in their browser. The token lands in /root/.azure, which is
// a named Docker volume the customer attaches via:
//
//   docker run ... -v orca-azure-session:/root/.azure ...
//
// Every subsequent run reuses the volume. No host filesystem access needed.

export interface AzureSession {
  tenantId: string;
  subscriptionId: string;
  subscriptionName: string;
  user: string;
}

/**
 * Returns the current az session if one exists and is non-stale, otherwise
 * null. "Stale" is detected by az itself returning a non-zero exit from
 * `az account show` — the CLI handles token refresh transparently, so a
 * failure here means either no session or a session whose refresh token
 * has also expired.
 */
export async function currentAzureSession(): Promise<AzureSession | null> {
  const res = await execaCommand('az account show -o json', {
    shell: true,
    reject: false,
    timeout: 15_000,
  });
  if (res.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    if (!parsed?.tenantId || !parsed?.id) return null;
    return {
      tenantId: parsed.tenantId,
      subscriptionId: parsed.id,
      subscriptionName: parsed.name ?? parsed.id,
      user: parsed.user?.name ?? 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * Runs `az login --use-device-code` interactively. The device code + URL
 * are streamed to the parent terminal; the customer opens the URL in a
 * browser on any device, enters the code, authenticates, and the CLI
 * completes. Returns the resulting session, or throws if login fails.
 *
 * We stream stdio directly so the device-code prompt appears in real time
 * rather than being buffered until az exits (which happens if we capture
 * stdout — and would be a terrible user experience for a flow that can
 * take 60+ seconds).
 */
export async function runDeviceCodeLogin(): Promise<AzureSession> {
  log.blank();
  log.heading('  Azure sign-in (device code)');
  log.dim('  No Azure session in the installer volume — signing you in now.');
  log.dim('  Copy the code below into the browser when prompted.');
  log.blank();

  await execaCommand('az login --use-device-code', {
    shell: true,
    stdio: 'inherit',
    reject: true,
    timeout: 10 * 60_000,
  });

  const session = await currentAzureSession();
  if (!session) {
    throw new Error('Login completed but `az account show` still fails — aborting');
  }
  log.blank();
  log.success(`  Signed in as ${session.user} (tenant ${session.tenantId})`);
  return session;
}

/**
 * Ensures the installer has an Azure CLI session before proceeding. If a
 * session already exists, prompts the deployer to confirm it's the right
 * one before reusing (catches the "I started this before lunch in a
 * different tenant" case). If none exists, runs device-code login.
 */
export async function ensureAzureSession(): Promise<AzureSession> {
  const existing = await currentAzureSession();
  if (existing) {
    log.blank();
    log.heading('  Existing Azure session detected');
    log.dim(`    User:          ${existing.user}`);
    log.dim(`    Tenant:        ${existing.tenantId}`);
    log.dim(`    Subscription:  ${existing.subscriptionName}`);
    log.blank();

    const reuse = await confirm({
      message: 'Use this session?',
      default: true,
    });
    if (reuse) return existing;

    // Force re-login — `az logout` empties the volume, then we fall through.
    log.dim('  Logging out of the existing session...');
    await execaCommand('az logout', {
      shell: true,
      reject: false,
      timeout: 10_000,
    });
  }
  return runDeviceCodeLogin();
}
