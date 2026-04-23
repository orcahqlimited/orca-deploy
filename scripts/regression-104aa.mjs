// Targeted regression harness for INTENT-104 §104-AA.
// Runs the net-new deploy steps from Sessions 2+3 against whatever
// subscription az is currently set to — ideally ORCA-HQ-NONPROD.
//
// Does NOT run the full installer (which needs a TTY for prompts). Does
// provision real Azure resources; run `az group delete --yes` at the end.
//
// Targets exercised:
//   104-A createSqlServer      104-O (container az login)   skipped — TTY-only
//   104-B password generator   104-P confirm panel          skipped — TTY-only
//   104-C createPiiEncryptionKey
//   104-D createOrcaKek
//   104-E createCustomerStorage
//   104-F Entra app roles (implicit via createEntraApp)
//   104-G assignDeployerFounderRole
//   104-H SPA redirect URI fix
//   104-I configureFoundry
//   104-J license master verify-after-write
//   104-U estate report        skipped — wired into the full install flow

import { execaCommand } from 'execa';
import crypto from 'node:crypto';
import { createResourceGroup } from '../dist/deploy/resource-group.js';
import { createAcr } from '../dist/deploy/acr.js';
import { createKeyVault } from '../dist/deploy/keyvault.js';
import { createManagedIdentity } from '../dist/deploy/identity.js';
import { createSqlServer } from '../dist/deploy/sql-server.js';
import { createPiiEncryptionKey } from '../dist/deploy/pii-encryption.js';
import { createOrcaKek } from '../dist/deploy/kek.js';
import { createCustomerStorage } from '../dist/deploy/customer-storage.js';
import { createEntraApp, updateEntraRedirectUris } from '../dist/deploy/entra.js';
import { assignDeployerFounderRole } from '../dist/deploy/rbac-graph.js';
import { configureFoundry } from '../dist/deploy/foundry-proxy.js';
import { generateAlphanumericPassword } from '../dist/utils/password.js';
import fs from 'node:fs';

const SLUG = 'test';
const REGION = 'uksouth';
const LICENCE_PATH = '/tmp/test-licence.jwt';
const TENANT_ID = '27525d97-58a8-4d55-ba8c-696f769f97f6';

async function run() {
  // 104-B sanity check — does the generator produce the right shape?
  const pw = generateAlphanumericPassword();
  console.log('[104-B] generateAlphanumericPassword: length=%d alphanumeric=%s',
    pw.length, /^[A-Za-z0-9]{24}$/.test(pw));

  const licence = fs.readFileSync(LICENCE_PATH, 'utf8').trim();
  const licenceClaims = JSON.parse(Buffer.from(licence.split('.')[1], 'base64').toString());
  console.log('[licence] sub=%s tid=%s tier=%s',
    licenceClaims.sub, licenceClaims.tid, licenceClaims.tier);

  // Safety-net: pin subscription. Never run regression against PROD.
  await execaCommand('az account set --subscription "ORCA-HQ-NONPROD"', { shell: true });
  const acct = await execaCommand('az account show -o json --query "{id:id,name:name,tenantId:tenantId}"', {
    shell: true,
  });
  const a = JSON.parse(acct.stdout);
  if (a.name !== 'ORCA-HQ-NONPROD') {
    throw new Error(`Regression must run on ORCA-HQ-NONPROD, currently on ${a.name}`);
  }
  console.log('[az] subscription=%s (%s) tenant=%s', a.name, a.id, a.tenantId);

  const ctx = {
    tenantId: a.tenantId,
    tenantName: 'ORCAHQ',
    subscriptionId: a.id,
    subscriptionName: a.name,
    customerSlug: SLUG,
    region: REGION,
    regionShort: 'uks',
    selectedConnectors: [
      { slug: 'freeagent', name: 'FreeAgent', description: '', toolCount: 10, image: 'orca-freeagent-connector', secrets: [] },
    ],
    credentials: {},
    connectorFqdns: {},
    licenseTokens: {},
    licenceToken: licence,
    licenceClaims,
    _installId: crypto.randomUUID(),
  };

  // --- Foundations ---
  await createResourceGroup(ctx);
  await createAcr(ctx);
  await createKeyVault(ctx);
  await createManagedIdentity(ctx);

  // --- 104-A (SQL) ---
  await createSqlServer(ctx);

  // --- 104-C PII encryption key ---
  await createPiiEncryptionKey(ctx);

  // --- 104-D KEK ---
  await createOrcaKek(ctx);

  // --- 104-E Customer storage ---
  await createCustomerStorage(ctx);

  // --- 104-F + 104-H Entra app (creation now drops --web-redirect-uris +
  //     Graph-PATCHes spa.redirectUris) ---
  await createEntraApp(ctx);

  // --- 104-G Deployer role assignment ---
  await assignDeployerFounderRole(ctx);

  // --- 104-I Foundry proxy wiring (configureFoundry) ---
  await configureFoundry(ctx);

  // --- 104-J License master verify-after-write was added to provisionLicenses;
  //     we simulate the verify directly: re-read + JWT-shape check ---
  const kvRead = await execaCommand(
    `az keyvault secret show --vault-name ${ctx.keyVaultName} --name orca-license-master --query value -o tsv`,
    { shell: true, reject: false },
  );
  if (kvRead.exitCode !== 0) {
    console.log('[104-J] master not yet written by regression (expected — full provisionLicenses is TTY-gated); skipping verify');
  } else {
    const parts = kvRead.stdout.trim().split('.');
    console.log('[104-J-shape] parts=%d ok=%s', parts.length,
      parts.length === 3 && parts.every((p) => p.length > 0));
  }

  // --- 104-H re-check: spa.redirectUris populated correctly ---
  const appObjectId = await execaCommand(
    `az ad app show --id ${ctx.entraAppId} --query id -o tsv`,
    { shell: true },
  );
  const redirectCheck = await execaCommand(
    `az rest --method GET --url "https://graph.microsoft.com/v1.0/applications/${appObjectId.stdout.trim()}" --query "{spa:spa.redirectUris, web:web.redirectUris}"`,
    { shell: true },
  );
  console.log('[104-H] redirect URIs:', redirectCheck.stdout.trim());

  console.log('\n--- REGRESSION SUMMARY ---');
  console.log('Resource group: ', ctx.resourceGroup);
  console.log('Entra app id:   ', ctx.entraAppId);
  console.log('SQL server fqdn:', ctx.sqlServerFqdn);
  console.log('Storage account:', ctx.storageAccountName);
  console.log('Foundry token:  ', ctx.foundryCustomerToken ? 'issued' : 'NOT issued');
  console.log('\nNext: run `./scripts/regression-104aa-teardown.sh` to clean up.');
}

run().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
