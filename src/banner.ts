import chalk from 'chalk';

const VERSION = '0.1.0';

export function showBanner(): void {
  console.log('');
  console.log(chalk.cyan(`   ____  ____   ____    _   `));
  console.log(chalk.cyan(`  / __ \\|  _ \\ / ___|  / \\  `));
  console.log(chalk.cyan(` | |  | | |_) | |     / _ \\ `));
  console.log(chalk.cyan(` | |  | |  _ <| |    / ___ \\`));
  console.log(chalk.cyan(`  \\____/|_| \\_\\\\____/_/   \\_\\`));
  console.log('');
  console.log(chalk.white.bold('  Intelligence Connectors'));
  console.log(chalk.dim(`  powered by ORCAHQ  v${VERSION}`));
  console.log('');
}
