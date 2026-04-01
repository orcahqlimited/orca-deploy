import type { ConnectorDef } from '../types.js';

export const ORCA_HQ_ACR = 'orcahqacruks.azurecr.io';

export const CONNECTORS: ConnectorDef[] = [
  {
    slug: 'freeagent',
    name: 'FreeAgent',
    description: '10 tools — accounting intelligence (OAuth2)',
    toolCount: 10,
    image: 'orca-freeagent-connector',
    secrets: [
      { kv: 'freeagent-client-id', env: 'FREEAGENT_CLIENT_ID', label: 'FreeAgent OAuth2 Client ID', masked: false },
      { kv: 'freeagent-client-secret', env: 'FREEAGENT_CLIENT_SECRET', label: 'FreeAgent OAuth2 Client Secret', masked: true },
      { kv: 'freeagent-refresh-token', env: 'FREEAGENT_REFRESH_TOKEN', label: 'FreeAgent Refresh Token (rotates on use)', masked: true },
    ],
  },
  {
    slug: 'freshworks',
    name: 'Freshworks',
    description: '23 tools — support desk + CRM (Freshdesk + Freshsales)',
    toolCount: 23,
    image: 'orca-freshworks-connector',
    secrets: [
      { kv: 'freshdesk-api-key', env: 'FRESHDESK_API_KEY', label: 'Freshdesk API Key', masked: true },
      { kv: 'freshdesk-domain', env: 'FRESHDESK_DOMAIN', label: 'Freshdesk subdomain (e.g. "acme" for acme.freshdesk.com)', masked: false },
      { kv: 'freshsales-api-key', env: 'FRESHSALES_API_KEY', label: 'Freshsales API Key', masked: true },
      { kv: 'freshsales-domain', env: 'FRESHSALES_DOMAIN', label: 'Freshsales domain (e.g. "acme.myfreshworks.com/crm/sales")', masked: false },
    ],
  },
  {
    slug: 'isms',
    name: 'ISMSOnline',
    description: '20 tools — ISO 27001 governance (JWT)',
    toolCount: 20,
    image: 'orca-isms-connector',
    secrets: [
      { kv: 'isms-secret-key', env: 'ISMS_SECRET_KEY', label: 'ISMSOnline API Secret Key', masked: true },
      { kv: 'isms-base-url', env: 'ISMS_BASE_URL', label: 'ISMSOnline API Base URL (default: https://rest.api.r1.isms.online)', masked: false },
    ],
  },
  {
    slug: 'ado',
    name: 'Azure DevOps',
    description: '8 tools — delivery intelligence (PAT)',
    toolCount: 8,
    image: 'orca-ado-connector',
    secrets: [
      { kv: 'ado-pat', env: 'ADO_PAT', label: 'Azure DevOps Personal Access Token', masked: true },
      { kv: 'ado-organisation', env: 'ADO_ORGANISATION', label: 'ADO Organisation (e.g. "https://dev.azure.com/myorg")', masked: false },
      { kv: 'ado-project', env: 'ADO_PROJECT', label: 'ADO Project name (optional, e.g. "MyProject")', masked: false },
    ],
  },
];

// Entra App Roles — created on every deployment
export const ENTRA_APP_ROLES = [
  { displayName: 'ORCA Founder', value: 'ORCA.Founder', description: 'Full system access', id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
  { displayName: 'ORCA Director', value: 'ORCA.Director', description: 'Director-level access', id: 'f47ac10b-58cc-4372-a567-0e02b2c3d480' },
  { displayName: 'ORCA Consultant', value: 'ORCA.Consultant', description: 'Consultant access', id: 'f47ac10b-58cc-4372-a567-0e02b2c3d481' },
  { displayName: 'ORCA Knowledge Operator', value: 'ORCA.KnowledgeOperator', description: 'Knowledge operations access', id: 'f47ac10b-58cc-4372-a567-0e02b2c3d482' },
  { displayName: 'ORCA Read Only', value: 'ORCA.ReadOnly', description: 'Read-only access', id: 'f47ac10b-58cc-4372-a567-0e02b2c3d483' },
];

// RC image tags — updated on each CLI release
export const IMAGE_TAGS: Record<string, string> = {
  'orca-freeagent-connector': 'rc-1.0.1',
  'orca-freshworks-connector': 'rc-1.0.1',
  'orca-isms-connector': 'rc-1.0.1',
  'orca-ado-connector': 'rc-1.0.1',
};
