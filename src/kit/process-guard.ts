import { spawn } from 'node:child_process';

export interface SafeCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Hard execution timeout in milliseconds (default: 5000ms) */
  timeoutMs?: number;
  /** Maximum combined stdout/stderr capture size in bytes (default: 2 MiB) */
  maxOutputBytes?: number;
  /** Optional stdin payload */
  stdinData?: string;
}

export interface SafeCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
}

/**
 * Terminate a child process and its descendants without hanging.
 * - Windows: `taskkill /PID <pid> /T /F` kills the entire Win32 process tree.
 * - macOS / Linux: kills the negative PGID (`-pid`, created via `detached: true` setsid) + direct `pid`.
 */
function forceKillProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.unref();
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Fallback if process is not a group leader
      }
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Process already exited.
  }
}

/**
 * Spawns a subprocess (`shell: false` strictly enforced against command injection)
 * with a hard timeout circuit breaker and output byte cap so no external tool can hang or OOM.
 */
export async function runCommandSafe(
  command: string,
  args: readonly string[],
  options: SafeCommandOptions = {},
): Promise<SafeCommandResult> {
  const timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
  const maxOutputBytes = Math.max(4_096, options.maxOutputBytes ?? 2 * 1024 * 1024);
  const start = performance.now();

  return new Promise<SafeCommandResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let outputTruncated = false;
    let totalBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const finish = (exitCode: number | null, extraErr?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderrBase = Buffer.concat(stderrChunks).toString('utf8');
      const stderr = extraErr ? (stderrBase ? `${stderrBase}\n${extraErr}` : extraErr) : stderrBase;
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        outputTruncated,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      });
    };

    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finish(-1, msg);
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore
      }
      forceKillProcessTree(child.pid);
      // Guarantee resolution within 200ms even if OS pipes linger on Windows
      setTimeout(() => finish(null, `Process timed out after ${timeoutMs}ms`), 150).unref();
    }, timeoutMs);
    timer.unref();

    const collectChunk = (target: Buffer[], chunk: Buffer) => {
      if (outputTruncated) return;
      if (totalBytes + chunk.length > maxOutputBytes) {
        const remaining = Math.max(0, maxOutputBytes - totalBytes);
        if (remaining > 0) {
          target.push(chunk.subarray(0, remaining));
        }
        totalBytes = maxOutputBytes;
        outputTruncated = true;
        return;
      }
      target.push(chunk);
      totalBytes += chunk.length;
    };

    child.stdout?.on('data', (chunk: Buffer) => collectChunk(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk: Buffer) => collectChunk(stderrChunks, chunk));

    child.on('error', (err) => {
      finish(-1, err.message);
    });

    child.on('close', (code) => {
      finish(code);
    });

    // Guard against unhandled EPIPE if the child exits before consuming stdin
    child.stdin?.on('error', () => {
      // Ignore broken pipe when child terminates early
    });
    if (options.stdinData !== undefined) {
      child.stdin?.end(options.stdinData, 'utf8');
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Wraps any async operation in a deterministic circuit breaker timeout.
 */
export async function withTimeoutCircuitBreaker<T>(
  label: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Circuit breaker tripped for "${label}" after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
    });
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Installs a fail-open self-termination watchdog inside synchronous CLI hooks
 * (`PreToolUse` / `PostToolUse`) so a hung filesystem call can never stall the Agent loop.
 */
export function installHookFailOpenWatchdog(timeoutMs: number, onTrip: () => never): () => void {
  const timer = setTimeout(() => {
    onTrip();
  }, timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}
