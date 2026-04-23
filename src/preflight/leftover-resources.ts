import { confirm, input } from '@inquirer/prompts';
import { az, azJson } from '../utils/az.js';
import type { PreflightResult } from '../types.js';
import * as log from '../utils/log.js';

// INTENT-ORCAHQ-104 §104-T — preflight detection of leftover ORCA resources
// from prior install attempts under different customer slugs.
//
// The AgileCadence install surfaced a specific failure mode (CL-ORCAHQ-0127):
// a customer typo'd their slug on a first attempt, the install got halfway,
// they cancelled + re-ran with the correct slug — leaving a half-built
// rg-orca-<typo>-uks + orca<typo>blobs* storage account sitting in the sub.
// The second install worked, but the customer was left with orphaned
// resources they didn't know how to clean up, and spent a 30-minute Slack
// thread with HQ chasing them.
//
// This check scans all resource groups in the subscription matching the
// ORCA naming convention `rg-orca-<slug>-<region>` and, for any slug that
// differs from the one being deployed right now, offers the operator three
// explicit choices (Founder Q3 resolution — no --reset flag; explicit action
// required):
//   1. Leave alone — the leftover is intentional (a second customer in this
//      sub, or a deliberately preserved prior install).
//   2. Tear down — `az group delete --yes --no-wait` each listed group.
//      Requires the operator to type the slug name as a confirmation.
//   3. Cancel — exit so the operator can pick a fresh non-colliding slug.

interface LeftoverGroup {
  name: string;
  slug: string;
  region: string;
  location: string;
}

const RG_NAME_RE = /^rg-orca-([a-z0-9]+)-([a-z0-9]+)$/;

export async function checkLeftoverResources(
  currentSlug: string,
): Promise<PreflightResult> {
  let groups: Array<{ name: string; location: string }>;
  try {
    groups = await azJson(
      'group list --query "[?starts_with(name, \'rg-orca-\')].{name:name,location:location}"',
    );
  } catch (err: any) {
    // Listing is non-fatal — preflight continues. The step after this is
    // checkNamingConflicts which catches the same-slug case.
    return {
      label: 'Leftover-resource scan (non-fatal: list failed)',
      passed: true,
      detail: err?.message,
    };
  }

  const leftovers: LeftoverGroup[] = [];
  for (const g of groups || []) {
    const m = RG_NAME_RE.exec(g.name);
    if (!m) continue;
    const slug = m[1];
    if (slug === currentSlug) continue; // same-slug = resume, handled elsewhere
    leftovers.push({ name: g.name, slug, region: m[2], location: g.location });
  }

  if (leftovers.length === 0) {
    return {
      label: 'No leftover ORCA resource groups from prior slugs',
      passed: true,
    };
  }

  log.warn('Existing ORCA resource groups found under different customer slugs:');
  log.blank();
  for (const lg of leftovers) {
    log.dim(`  ${lg.name}  (slug "${lg.slug}", ${lg.location})`);
  }
  log.blank();
  log.dim(
    'These are from prior install attempts or other customers in this subscription.',
  );
  log.dim(
    'The current install with slug "' +
      currentSlug +
      '" will not touch them, but leaving stale slugs around is messy.',
  );
  log.blank();
  log.dim('Pick one:');
  log.dim('  leave     — keep the stale resource groups (the default)');
  log.dim('  teardown  — delete them (type the slug to confirm each)');
  log.dim('  cancel    — exit so you can re-launch with a fresh non-colliding slug');
  log.blank();

  const action = await input({
    message: 'Action for leftover groups [leave / teardown / cancel]:',
    default: 'leave',
    validate: (v) =>
      ['leave', 'teardown', 'cancel'].includes(v.trim().toLowerCase())
        ? true
        : 'Enter one of: leave, teardown, cancel',
  });

  const picked = action.trim().toLowerCase();

  if (picked === 'cancel') {
    return {
      label: 'Leftover-resource review',
      passed: false,
      detail: 'Operator cancelled to choose a fresh slug',
      remediation: 'Re-run the installer with a non-colliding customer slug.',
    };
  }

  if (picked === 'leave') {
    return {
      label: `Leftover groups ignored (${leftovers.length} group(s))`,
      passed: true,
    };
  }

  // Teardown — confirm each group by slug typing.
  for (const lg of leftovers) {
    const confirmSlug = await input({
      message: `Type the slug "${lg.slug}" to delete ${lg.name}:`,
    });
    if (confirmSlug.trim() !== lg.slug) {
      log.dim(`  Skipping ${lg.name} (confirmation mismatch)`);
      continue;
    }
    log.dim(`  Queueing delete: az group delete --name ${lg.name} --yes --no-wait`);
    await az(`group delete --name ${lg.name} --yes --no-wait`).catch((err) => {
      log.warn(`  Delete failed for ${lg.name}: ${err?.message || err}`);
    });
  }

  // Not strictly required for the deploy — group deletes run async in Azure
  // and may still be in progress when the installer continues.
  const also = await confirm({
    message: 'Delete pending — continue with install?',
    default: true,
  });
  if (!also) {
    return {
      label: 'Leftover-resource teardown initiated',
      passed: false,
      detail: 'Operator chose to stop and wait for deletes to complete',
    };
  }

  return {
    label: `Leftover-resource teardown initiated (${leftovers.length} group(s), async)`,
    passed: true,
  };
}
