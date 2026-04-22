// Phone-home telemetry — lets ORCA HQ know which customers are installing,
// when, against which tenant, and whether the install succeeded. Non-blocking:
// an unreachable licence service never fails the install. A failed telemetry
// post logs a warning and continues.
//
// Events sent:
//   install.start     — after licence verification, before any Azure calls
//   install.complete  — after health checks pass
//   install.fail      — from the top-level catch in deploy/index.ts
//   install.upgrade   — (future) when re-running against an existing deploy
//
// All events carry a stable install_id (UUID) so start + complete/fail can
// be joined server-side. No customer credentials, no connector secrets, no
// licence JWT in the bodies — the JWT only appears in the Authorization
// header for auth against the licence service's masterLicenceAuth middleware.

import crypto from 'node:crypto';
import os from 'node:os';
import https from 'node:https';
import { URL } from 'node:url';
import type { DeployContext } from '../types.js';
import * as log from '../utils/log.js';

const LICENSE_SERVICE_URL =
  process.env.LICENSE_SERVICE_URL
  || 'https://orca-license-service.icyplant-8c8bf272.uksouth.azurecontainerapps.io';

const INSTALLER_VERSION = process.env.INSTALLER_VERSION || 'dev';

export interface InstallEvent {
  event: 'install.start' | 'install.complete' | 'install.fail' | 'install.upgrade';
  install_id: string;
  customer_slug: string;
  tenant_id: string;
  subscription_id?: string;
  region?: string;
  connectors?: string[];
  duration_ms?: number;
  error?: string;
  host_hash?: string;
  installer_version?: string;
}

function hostHash(): string {
  // Deterministic but non-PII hostname fingerprint. Helps dedupe repeat installs
  // from the same workstation without exposing the raw hostname.
  return crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
}

export function newInstallId(): string {
  return crypto.randomUUID();
}

function post(path: string, body: object, bearer: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    const u = new URL(path, LICENSE_SERVICE_URL);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': `Bearer ${bearer}`,
        },
      },
      (res) => {
        // Drain body to free the socket. We don't care about the response
        // content — 202 is expected on success but even a 4xx/5xx shouldn't
        // break the install.
        res.on('data', () => {});
        res.on('end', () => resolve());
      },
    );
    req.on('error', () => resolve());       // never throw
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(); });
    req.write(payload);
    req.end();
  });
}

export async function sendInstallEvent(
  ctx: DeployContext,
  event: InstallEvent['event'],
  extra: Partial<InstallEvent> = {},
): Promise<void> {
  if (!ctx.licenceToken || !ctx.licenceClaims) {
    // No licence = nothing to phone with. Should never happen since this is
    // called only after licence verification.
    return;
  }
  if (!ctx._installId) {
    ctx._installId = newInstallId();
  }

  const body: InstallEvent = {
    event,
    install_id: ctx._installId,
    customer_slug: ctx.licenceClaims.sub,
    tenant_id: ctx.licenceClaims.tid,
    subscription_id: ctx.subscriptionId,
    region: ctx.region,
    connectors: ctx.selectedConnectors?.map((c) => c.slug) || [],
    host_hash: hostHash(),
    installer_version: INSTALLER_VERSION,
    ...extra,
  };

  try {
    await post('/api/telemetry/install-event', body, ctx.licenceToken);
  } catch (err: any) {
    // Non-fatal — log and swallow. The installer must never fail because
    // phone-home couldn't reach ORCA HQ.
    log.dim(`(phone-home ${event} failed: ${err?.message || 'unknown'} — continuing)`);
  }
}
