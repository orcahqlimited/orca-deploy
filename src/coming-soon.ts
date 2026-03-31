import chalk from 'chalk';
import * as log from './utils/log.js';

export function showComingSoon(): void {
  log.blank();
  log.heading('  Coming Soon');
  log.divider();
  console.log(chalk.dim('  ORCA Knowledge Brain    ') + chalk.white('— organisational intelligence store'));
  console.log(chalk.dim('  ORCA Vector Search      ') + chalk.white('— semantic knowledge retrieval'));
  console.log(chalk.dim('  ORCA PII Vault          ') + chalk.white('— encrypted personal data protection'));
  console.log(chalk.dim('  ORCA SimpleX Interface  ') + chalk.white('— private conversational access'));
  log.divider();
  console.log(chalk.dim('  These components will be available in a future release.'));
  log.blank();
}
