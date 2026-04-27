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
  // Customer-owned VNet carrying the cae-infra subnet. Peered to the AKS
  // managed VNet so the gateway can reach the Qdrant internal LB VIP.
  vnetName?: string;
  vnetId?: string;
  caeSubnetId?: string;
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
  // SQL server + PII vault (INTENT-017 / INTENT-104 §104-A)
  sqlServerName?: string;
  sqlServerFqdn?: string;
  sqlAdminUser?: string;
  // Storage account hosting encrypted personal-brain blobs (104-E)
  storageAccountName?: string;
  storageAccountId?: string;
  // Foundry proxy customer token — issued by orca-license-service, stored
  // in customer KV, attached by the gateway to every foundry.orcahq.ai call.
  foundryCustomerToken?: string;
  // orca-ingest optional install step (INTENT-106). Set once the user
  // confirms the prompt, populated as the step progresses. Read by
  // printSummary to surface the ready-to-run seed command.
  ingestEnabled?: boolean;
  ingestEntraAppId?: string;
  ingestEntraClientId?: string;
  ingestEnvFilePath?: string;
  ingestImageRef?: string;
  ingestConsentPending?: boolean;
  // Licence — verified at startup, written to KV as orca-license-master
  // during provisionLicenses. No offline-grace fallback.
  // Stable UUID for the install run, used to join phone-home events
  // (install.start / install.complete / install.fail) server-side.
  _installId?: string;
  licenceToken?: string;
  licenceClaims?: {
    iss: string;
    sub: string;
    tid: string;
    jti: string;
    type: string;
    tier: string;
    maxConnectors: number;
    connectors: string[];
    iat: number;
    exp: number;
  };
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
