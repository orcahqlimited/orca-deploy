#!/usr/bin/env node
// Dry-run: exercise preflight + print the deploy plan without any resource
// creation. Uses a scratch customer slug that we delete from ctx before exit.
//
// This does NOT call az commands that mutate state. Preflight is read-only.

import { runPreflight } from '../dist/preflight/index.js';
import * as log from '../dist/utils/log.js';

const ctx = {
  // Scratch identity — no Azure side-effects occur from these values at
  // preflight time because preflight only reads CLI state + current az session.
  tenantId: '27525d97-58a8-4d55-ba8c-696f769f97f6',
  tenantName: 'orcahqlimited',
  subscriptionId: 'ec35a6df-1472-47e5-92f6-e60afb44a817',
  subscriptionName: 'ORCA-HQ-PROD',
  customerSlug: 'dryrun',
  region: 'uksouth',
  regionShort: 'uks',
  selectedConnectors: [],
  credentials: {},
  connectorFqdns: {},
  licenseTokens: {},
  // Custom domain is optional; leave unset to match the "no custom domain"
  // path, which matches our AgileCadence baseline (they can add later).
  customGatewayDomain: undefined,
};

console.log('\n=== orca-deploy dry-run — preflight only ===\n');

try {
  const ok = await runPreflight(ctx);
  if (ok) {
    log.blank();
    log.success('Dry-run complete — preflight passed');
    process.exit(0);
  } else {
    log.blank();
    log.fail('Dry-run complete — preflight failed (see above)');
    process.exit(1);
  }
} catch (err) {
  log.blank();
  log.fail(`Dry-run failed with exception: ${err.message}`);
  console.error(err.stack);
  process.exit(2);
}
