import crypto from 'node:crypto';
import type { DeployContext } from '../types.js';
import { az, azQuiet } from '../utils/az.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

// INTENT-ORCAHQ-104 §104-C — createPiiEncryptionKey.
//
// Provisions the symmetric PII encryption key used by the gateway's
// tokenisation layer (INTENT-016 three-layer defence). AES-256, hex-encoded,
// stored as a Key Vault secret. An existence guard ensures re-runs never
// regenerate the key — regenerating would orphan every previously-tokenised
// PII value. Rotation is a separate, explicit operation handled outside
// the installer.

export async function createPiiEncryptionKey(ctx: DeployContext): Promise<void> {
  const secretName = naming.PII_ENCRYPTION_KEY_SECRET;
  const s = log.spinner(`PII encryption key: ${secretName}`);

  const existing = await az(
    `keyvault secret show --vault-name ${ctx.keyVaultName} --name ${secretName}`,
  );
  if (existing.exitCode === 0) {
    s.succeed(`  PII encryption key: ${secretName} (existing — preserved, rotation is a separate op)`);
    return;
  }

  // 256-bit AES key, hex-encoded (64 chars).
  const key = crypto.randomBytes(32).toString('hex');
  await azQuiet(
    `keyvault secret set --vault-name ${ctx.keyVaultName} --name ${secretName} --value "${key}"`,
  );

  s.succeed(`  PII encryption key: ${secretName} (256-bit AES, generated, never regenerated)`);
}
