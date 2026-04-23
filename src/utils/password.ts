import crypto from 'node:crypto';

// Alphanumeric-only password generator.
//
// Why alphanumeric: SQL Server admin passwords, Storage Account keys derived
// from passwords, and Key Vault secret values all travel through shells +
// JSON + PowerShell at various points in the installer. PowerShell's
// `[Membership]::GeneratePassword` — which we used before CL-ORCAHQ-0130 —
// emits `!@#$%^&*()` characters that get interpreted as shell metacharacters
// when the installer hands the password off (most recently surfaced during
// the AgileCadence day-1 install where the SQL admin password tripped
// `bash -c` escape handling). Restricting to [A-Za-z0-9] removes the entire
// class of escape bugs without meaningfully reducing entropy.
//
// Entropy math: 62 chars × 24-length = log2(62^24) ≈ 143 bits of entropy.
// Well above the NIST 128-bit threshold for sensitive credentials.
//
// Usage: generateAlphanumericPassword() // 24 chars
//        generateAlphanumericPassword(32) // custom length

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateAlphanumericPassword(length = 24): string {
  if (length < 16) throw new Error(`refusing length ${length} — minimum 16`);
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
