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

export function connectorAppName(connectorSlug: string): string {
  return `orca-${connectorSlug}-connector`;
}
