import { execaCommand } from 'execa';

export interface AzResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function az(command: string): Promise<AzResult> {
  try {
    const result = await execaCommand(`az ${command}`, {
      shell: true,
      timeout: 120_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
      exitCode: err.exitCode || 1,
    };
  }
}

export async function azJson<T = any>(command: string): Promise<T> {
  const result = await az(`${command} -o json`);
  if (result.exitCode !== 0) {
    throw new Error(`az ${command} failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

export async function azTsv(command: string): Promise<string> {
  const result = await az(`${command} -o tsv`);
  if (result.exitCode !== 0) {
    throw new Error(`az ${command} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function azQuiet(command: string): Promise<void> {
  const result = await az(`${command} -o none`);
  if (result.exitCode !== 0) {
    throw new Error(`az ${command} failed: ${result.stderr}`);
  }
}
