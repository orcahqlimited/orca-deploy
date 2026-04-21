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
  licenseServiceEndpoint?: string;
  licenseTokens: Record<string, string>;   // connector-slug → licence JWT
  // AKS + Qdrant (optional — core ORCA vector store)
  aksResourceGroup?: string;
  aksClusterName?: string;
  qdrantInternalUrl?: string;
  // Meeting capture (INTENT-095 / transcript subscription)
  founderOid?: string;                  // OID of the signed-in deployer (Founder in customer tenant)
  eligibilityGroupOid?: string;         // ORCA-Eligible group OID
  graphSubscriptionId?: string;         // Graph change-notification subscription id
  graphClientState?: string;            // Random client state shared with gateway
  // Core product Container App FQDNs
  gatewayFqdn?: string;
  gatewayUrl?: string;                  // Customer's deployed gateway URL (https://...)
  copilotFqdn?: string;
  copilotUrl?: string;
  copilotEntraAppId?: string;
  copilotEntraClientSecret?: string;
  governancePortalFqdn?: string;
  governancePortalUrl?: string;
  governanceConnectorFqdn?: string;
  governanceConnectorUrl?: string;
  licenseServiceFqdn?: string;
  // Customer custom domain for the gateway (e.g. gateway.agilecadence.co.uk).
  // Optional; if set, bound to the gateway Container App after deploy and used
  // to populate GATEWAY_URL everywhere. If absent, gateway FQDN is used as-is.
  customGatewayDomain?: string;
  // Whether the custom-domain managed certificate has been issued and the
  // hostname binding is validated. Drives whether GATEWAY_URL switches over.
  customGatewayDomainBound?: boolean;
  // Gateway-specific secrets
  heartbeatSecret?: string;
  graphWebhookClientState?: string;
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
