// Licence verification — runs before any Azure resource is created.
//
// The installer refuses to proceed unless the customer has supplied a valid
// ORCA_LICENCE_KEY in their environment. The licence is a JWT signed by ORCA
// HQ's licence service (RS256). We verify:
//
//   - Signature with the embedded ORCA HQ public key (baked into the image).
//   - exp claim — the licence has not expired.
//   - iss claim — the licence was issued by ORCA HQ.
//   - tid claim — the tenant this licence is for matches the tenant the
//     installer is currently signed in to.
//
// If any check fails, we exit with code 2 and a message pointing at the
// licence-refresh path. No resources are created, no Azure calls beyond
// `az account show` are made.
//
// The raw licence token is passed through on ctx.licenceToken so the rest
// of the deploy pipeline can write it to the customer's Key Vault as the
// master licence (used by the runtime connectors).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { azJson } from '../utils/az.js';
import * as log from '../utils/log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PEM lives in the src/ tree and is copied to dist/ by tsc (see tsconfig.json
// resources entry) or baked into the Docker image. We resolve it relative to
// the compiled file so both local-dev and container-run paths work.
const PEM_FILENAME = 'orca-hq-licence.pub.pem';

export interface LicenceClaims {
  iss: string;
  sub: string;                // customer slug
  tid: string;                // customer Azure tenant id
  jti: string;
  type: 'master';
  tier: string;
  maxConnectors: number;
  connectors: string[];
  iat: number;
  exp: number;
}

export interface LicenceResult {
  claims: LicenceClaims;
  token: string;              // raw JWT — passed through for KV write
}

function loadPublicKey(): string {
  // Search common locations (local src, dist, docker copy)
  const candidates = [
    path.join(__dirname, PEM_FILENAME),
    path.join(__dirname, '..', '..', 'src', 'licence', PEM_FILENAME),
    path.join('/orca', 'licence', PEM_FILENAME),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error(
    `ORCA HQ licence public key not found. Searched:\n  ${candidates.join('\n  ')}\n` +
    `This is a build/packaging problem — contact ORCA HQ.`,
  );
}

/**
 * Verify the licence in process.env.ORCA_LICENCE_KEY against the current
 * Azure signed-in tenant. Throws with a human-readable message on any
 * failure. Returns the parsed claims + the raw token on success.
 */
export async function verifyLicence(): Promise<LicenceResult> {
  const token = process.env.ORCA_LICENCE_KEY;
  if (!token || token.trim().length === 0) {
    throw new Error(
      'ORCA_LICENCE_KEY is not set.\n\n' +
      'Every install requires a licence issued by ORCA HQ. Ask your ORCA contact\n' +
      'to issue one, then re-run with:\n\n' +
      '  docker run --rm -it -v ~/.azure:/root/.azure \\\n' +
      '    -e ORCA_LICENCE_KEY=<your licence> \\\n' +
      '    ghcr.io/orcahqlimited/orca-installer:latest\n',
    );
  }

  let pem: string;
  try {
    pem = loadPublicKey();
  } catch (err: any) {
    throw new Error(err.message);
  }

  // 1. Verify signature + expiry + issuer
  let claims: LicenceClaims;
  try {
    claims = jwt.verify(token.trim(), pem, {
      algorithms: ['RS256'],
      issuer: 'orca-license-service',
    }) as LicenceClaims;
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      throw new Error(
        `Licence has expired (exp: ${err.expiredAt?.toISOString?.() || 'unknown'}).\n` +
        'Request a fresh licence from your ORCA contact and re-run.',
      );
    }
    if (err.name === 'JsonWebTokenError') {
      throw new Error(
        `Licence is invalid: ${err.message}.\n` +
        'Confirm you are using the exact string ORCA HQ sent you. If in doubt, request a fresh licence.',
      );
    }
    throw new Error(`Licence verification failed: ${err.message}`);
  }

  if (claims.type !== 'master') {
    throw new Error(
      `Licence type is "${claims.type}", expected "master". ORCA HQ issues master licences for installs; ` +
      'child licences are for runtime only. Request a master licence.',
    );
  }

  // 2. Verify tenant match — the licence is bound to a specific Azure tenant
  let currentTenantId: string;
  try {
    const account = await azJson<{ tenantId: string }>(
      'account show --query "{tenantId:tenantId}"',
    );
    currentTenantId = account.tenantId;
  } catch {
    throw new Error(
      'Could not determine the currently signed-in Azure tenant.\n' +
      'Run `az login --tenant <your-tenant-id>` then re-run the installer.',
    );
  }

  if (claims.tid.toLowerCase() !== currentTenantId.toLowerCase()) {
    throw new Error(
      `Licence is bound to tenant ${claims.tid} but you are currently signed in to ${currentTenantId}.\n` +
      'Either sign in to the tenant the licence was issued for, or request a licence for the tenant you are in.',
    );
  }

  return { claims, token: token.trim() };
}

/**
 * Pretty-print a verified licence to the console. Called after verifyLicence
 * succeeds, before preflight.
 */
export function printLicenceSummary(r: LicenceResult): void {
  const expires = new Date(r.claims.exp * 1000);
  const daysLeft = Math.floor((r.claims.exp - Math.floor(Date.now() / 1000)) / 86400);
  log.heading('  Licence');
  log.success(`  Customer: ${r.claims.sub}`);
  log.success(`  Tier: ${r.claims.tier}`);
  log.success(`  Connectors authorised: ${r.claims.connectors.join(', ')}`);
  log.success(`  Expires: ${expires.toISOString().split('T')[0]} (${daysLeft} days left)`);
}
