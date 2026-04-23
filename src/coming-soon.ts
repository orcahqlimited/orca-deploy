import chalk from 'chalk';
import * as log from './utils/log.js';

export function showComingSoon(): void {
  // INTENT-ORCAHQ-104 §104-Q — Coming Soon shows only components that are
  // genuinely not yet installed by this installer. Knowledge Brain + Vector
  // Search + PII Vault all deploy today (INTENTs 001 / 016 / 017) so listing
  // them as "coming soon" was misleading to the deployer (CL-ORCAHQ-0120 —
  // AgileCadence Founder asked "why are these coming soon? I saw them get
  // deployed five minutes ago"). Only SimpleX remains genuinely future work.
  log.blank();
  log.heading('  Coming Soon');
  log.divider();
  console.log(chalk.dim('  ORCA SimpleX Interface  ') + chalk.white('— private conversational access'));
  log.divider();
  console.log(chalk.dim('  This component will be available in a future release.'));
  log.blank();
}
