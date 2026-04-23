import { REGIONS } from '../types.js';

export function regionShort(region: string): string {
  return REGIONS[region] || region.slice(0, 3);
}

export function resourceGroup(customer: string, region: string): string {
  return `rg-orca-${customer}-${regionShort(region)}`;
}

export function acrName(customer: string, region: string): string {
  // ACR names: alphanumeric only, 5-50 chars
  return `orca${customer}acr${regionShort(region)}`;
}

export function keyVaultName(customer: string, region: string): string {
  // KV names: 3-24 chars, alphanumeric + hyphens
  return `kv-orca-${customer}-${regionShort(region)}`;
}

export function managedIdentityName(customer: string): string {
  return `orca-${customer}-mi`;
}

export function caEnvironmentName(customer: string, region: string): string {
  return `orca-${customer}-cae-${regionShort(region)}`;
}

export function vnetName(customer: string, region: string): string {
  return `vnet-orca-${customer}-${regionShort(region)}`;
}

export function connectorAppName(connectorSlug: string): string {
  return `orca-${connectorSlug}-connector`;
}

// Core product Container App names (customer-tenant-scoped)
export function gatewayAppName(_customer: string): string {
  return `orca-mcp-gateway`;
}

export function copilotAppName(_customer: string): string {
  return `orca-copilot`;
}

export function governancePortalAppName(_customer: string): string {
  return `orca-governance-portal`;
}

export function governanceConnectorAppName(_customer: string): string {
  return `orca-governance-connector`;
}

export function licenseServiceAppName(_customer: string): string {
  return `orca-license-service`;
}

export function copilotEntraAppName(customer: string): string {
  return `ORCA Copilot (${customer})`;
}

export function copilotBotName(_customer: string): string {
  return `orca-copilot-bot`;
}

// Azure SQL server — 1-63 chars, lowercase letters/digits/hyphens, starts/ends alnum.
export function sqlServerName(customer: string, region: string): string {
  return `orca-${customer}-sql-${regionShort(region)}`;
}

// PII vault DB name is fixed across all customers — referenced by the
// orca-mcp-gateway without a customer-slug suffix.
export const SQL_PII_VAULT_DB = 'orca-pii-vault';

// Azure Storage account — 3-24 chars, lowercase alphanumeric only, globally
// unique. We use a slug-derived prefix + `blobs` + regionShort to stay
// within the 24-char ceiling for slugs up to 13 chars.
export function storageAccountName(customer: string, region: string): string {
  return `orca${customer}blobs${regionShort(region)}`.toLowerCase().slice(0, 24);
}

// Container within the storage account holding the customer's encrypted
// personal-brain blobs (INTENT-017 envelope encryption; DEK-wrapped payload
// per entry, KEK in Key Vault). One container per customer account.
export const ENCRYPTED_BRAIN_CONTAINER = 'orca-encrypted-brain';

// KEK secret names in the customer Key Vault. These are secret names, not
// values — the values are generated during deploy and live only in KV.
export const ORCA_KEK_KEY_NAME = 'orca-kek';           // RSA-2048 key (wrap/unwrap)
export const PII_ENCRYPTION_KEY_SECRET = 'pii-encryption-key'; // AES-256 hex

