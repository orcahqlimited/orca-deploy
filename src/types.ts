export interface ConnectorSecret {
  kv: string;       // Key Vault secret name
  env: string;      // Container App env var name
  label: string;    // Prompt label for the deployer
  masked: boolean;  // Mask input (passwords, keys)
}

export interface ConnectorDef {
  slug: string;
  name: string;
  description: string;
  toolCount: number;
  image: string;           // Image name in ACR (without registry prefix)
  secrets: ConnectorSecret[];
}

export interface DeployContext {
  tenantId: string;
  tenantName: string;
  subscriptionId: string;
  subscriptionName: string;
  customerSlug: string;
  region: string;
  regionShort: string;
  selectedConnectors: ConnectorDef[];
  credentials: Record<string, string>;  // kv-secret-name → value
  // Computed during deployment
  resourceGroup?: string;
  acrName?: string;
  acrLoginServer?: string;
  keyVaultName?: string;
  keyVaultId?: string;
  miName?: string;
  miId?: string;
  miPrincipalId?: string;
  miClientId?: string;
  entraAppId?: string;
  entraClientSecret?: string;
  caEnvironment?: string;
  caDomain?: string;
  jwtSigningKey?: string;
  connectorFqdns: Record<string, string>;  // slug → fqdn
  orcaAcrToken?: string;
}

export interface PreflightResult {
  label: string;
  passed: boolean;
  detail?: string;
  remediation?: string;
}

export const REGIONS: Record<string, string> = {
  'uksouth': 'uks',
  'ukwest': 'ukw',
  'westeurope': 'weu',
  'northeurope': 'neu',
  'eastus': 'eus',
  'eastus2': 'eu2',
  'westus2': 'wu2',
  'australiaeast': 'aue',
  'southeastasia': 'sea',
};
