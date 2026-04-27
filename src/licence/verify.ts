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
 * Resolve the licence token from the environment.
 *
 * Two paths, in priority order:
 *   1. ORCA_LICENCE_FILE — path to a file containing the licence JWT.
 *      Recommended when the host terminal (PowerShell + PSReadLine,
 *      VS Code's paste limit, Win-cmd shells with line-length caps,
 *      etc.) might truncate a pasted env var. Reads the file, trims
 *      whitespace, returns the contents. This is the post-TASK-112
 *      preferred path — file-based input bypasses every paste-
 *      truncation surface we know about.
 *   2. ORCA_LICENCE_KEY — the raw JWT in the env var. Continues to
 *      work; we just gained a shape-check at the next step that
 *      catches truncation explicitly instead of surfacing an
 *      "invalid signature" error.
 */
function resolveLicenceToken(): { token: string; source: 'file' | 'env' } | null {
  const file = process.env.ORCA_LICENCE_FILE;
  if (file && file.trim().length > 0) {
    try {
      const body = fs.readFileSync(file.trim(), 'utf8');
      return { token: body.trim(), source: 'file' };
    } catch (err: any) {
      throw new Error(
        `ORCA_LICENCE_FILE is set to ${file} but the file could not be read: ${err.message}.\n` +
        'Confirm the path (inside the container if running via docker -e) and that the file is mounted/readable.',
      );
    }
  }
  const env = process.env.ORCA_LICENCE_KEY;
  if (env && env.trim().length > 0) {
    return { token: env.trim(), source: 'env' };
  }
  return null;
}

/**
 * Heuristic shape check on the supplied JWT. Catches the
 * paste-truncation case (CL-from-AC redeploy 2026-04-26: licence
 * arrived as 442 bytes when it should have been 830 — likely
 * PowerShell + VS Code terminal paste limit). The native
 * jwt.verify() error on a truncated signature is "invalid
 * signature", which is unactionable. This check surfaces
 * "your licence appears truncated" instead, with the file-based
 * alternative as the recommended fix.
 *
 * RS256-2048 reference shapes:
 *   - 3 dot-separated base64url parts
 *   - signature part: 342–344 base64url chars (256 bytes × 4/3, no padding)
 *   - total length: 600–1000+ bytes for our claim payload
 *
 * Anything under 500 bytes total or with a signature part under 300
 * chars is almost certainly truncated. We're permissive at the
 * upper end (no enforced max) to avoid false-positives on payload
 * variations.
 */
function checkLicenceShape(token: string, source: 'file' | 'env'): void {
  if (token.length < 200) {
    throw new Error(
      `Licence appears truncated — got ${token.length} bytes, expected 600+.\n` +
      shapeRemediation(source),
    );
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(
      `Licence is malformed — JWTs have exactly 3 dot-separated parts, got ${parts.length}.\n` +
      'Confirm you copied the full string from ORCA HQ (no extra whitespace, no leading "Bearer ").',
    );
  }
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) {
    throw new Error(
      'Licence is malformed — one of the three JWT parts is empty.\n' +
      shapeRemediation(source),
    );
  }
  if (sigB64.length < 300) {
    throw new Error(
      `Licence signature is too short (${sigB64.length} chars; RS256-2048 produces ~342). The licence is almost certainly truncated.\n` +
      shapeRemediation(source),
    );
  }
}

function shapeRemediation(source: 'file' | 'env'): string {
  if (source === 'file') {
    return (
      'Re-fetch the licence from ORCA HQ and confirm the file size matches what was sent.\n' +
      'If you copy-pasted into the file, prefer downloading directly from the source.'
    );
  }
  return (
    'Cause is almost always paste truncation in PowerShell + PSReadLine, VS Code\n' +
    'terminal paste limits, or shell history line-length caps.\n\n' +
    'Recommended fix — write the licence to a file and use ORCA_LICENCE_FILE instead:\n\n' +
    '  # Save the licence to ~/orca/licence.jwt (mode 0600 if you can)\n' +
    '  docker run --rm -it -v ~/.azure:/root/.azure \\\n' +
    '    -v ~/orca/licence.jwt:/orca/licence.jwt:ro \\\n' +
    '    -e ORCA_LICENCE_FILE=/orca/licence.jwt \\\n' +
    '    ghcr.io/orcahqlimited/orca-installer:latest\n\n' +
    'File-based input bypasses every paste-truncation surface.'
  );
}

/**
 * Verify the licence in process.env.ORCA_LICENCE_KEY (or a file at
 * ORCA_LICENCE_FILE) against the current Azure signed-in tenant.
 * Throws with a human-readable message on any failure. Returns the
 * parsed claims + the raw token on success.
 */
export async function verifyLicence(): Promise<LicenceResult> {
  const resolved = resolveLicenceToken();
  if (!resolved) {
    throw new Error(
      'ORCA_LICENCE_KEY (or ORCA_LICENCE_FILE) is not set.\n\n' +
      'Every install requires a licence issued by ORCA HQ. Ask your ORCA contact\n' +
      'to issue one, then re-run with one of:\n\n' +
      '  # File-based (recommended — avoids paste-truncation surfaces)\n' +
      '  docker run --rm -it -v ~/.azure:/root/.azure \\\n' +
      '    -v ~/orca/licence.jwt:/orca/licence.jwt:ro \\\n' +
      '    -e ORCA_LICENCE_FILE=/orca/licence.jwt \\\n' +
      '    ghcr.io/orcahqlimited/orca-installer:latest\n\n' +
      '  # Env var (only if the licence pastes cleanly into your shell)\n' +
      '  docker run --rm -it -v ~/.azure:/root/.azure \\\n' +
      '    -e ORCA_LICENCE_KEY=<your licence> \\\n' +
      '    ghcr.io/orcahqlimited/orca-installer:latest\n',
    );
  }

  // TASK-112 — explicit shape check before jwt.verify(). Truncated
  // licences would otherwise fail with the unactionable "invalid
  // signature" error.
  checkLicenceShape(resolved.token, resolved.source);

  const token = resolved.token;

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
