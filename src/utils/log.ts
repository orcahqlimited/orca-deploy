import chalk from 'chalk';
import ora, { type Ora } from 'ora';

export function success(msg: string): void {
  console.log(`  ${chalk.green('✓')} ${msg}`);
}

export function fail(msg: string): void {
  console.log(`  ${chalk.red('✗')} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${chalk.blue('ℹ')} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${chalk.yellow('⚠')} ${msg}`);
}

export function heading(msg: string): void {
  console.log('');
  console.log(chalk.bold.cyan(msg));
}

export function dim(msg: string): void {
  console.log(chalk.dim(`  ${msg}`));
}

export function blank(): void {
  console.log('');
}

export function spinner(text: string): Ora {
  return ora({ text: `  ${text}`, color: 'cyan' }).start();
}

export function divider(): void {
  console.log(chalk.dim('  ' + '─'.repeat(50)));
}
