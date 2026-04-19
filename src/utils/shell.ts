import { execaCommand } from 'execa';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run an arbitrary shell command (used for kubectl, helm, etc.).
 * Mirrors the shape of utils/az.ts so callers can treat errors uniformly.
 *
 * NEVER use fetch() in this codebase — this wrapper is the only
 * sanctioned way to call out to external CLIs.
 */
export async function sh(command: string, timeoutMs = 300_000): Promise<ShellResult> {
  try {
    const result = await execaCommand(command, {
      shell: true,
      timeout: timeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
      exitCode: err.exitCode ?? 1,
    };
  }
}

export async function shOrThrow(command: string, timeoutMs = 300_000): Promise<string> {
  const result = await sh(command, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/**
 * Run a command that is allowed to "fail" in an idempotent sense —
 * e.g. `helm repo add` when the repo already exists, or
 * `kubectl create namespace` when the namespace is present.
 *
 * Only throws if stderr contains a real error line AND the command failed.
 */
export async function shIdempotent(
  command: string,
  tolerateSubstrings: string[] = [],
  timeoutMs = 300_000,
): Promise<void> {
  const result = await sh(command, timeoutMs);
  if (result.exitCode === 0) return;
  const combined = `${result.stdout}\n${result.stderr}`;
  if (tolerateSubstrings.some(s => combined.includes(s))) {
    return;
  }
  throw new Error(`${command} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
}
