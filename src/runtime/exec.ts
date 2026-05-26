// Subprocess discipline: spawn with detached process group so we can SIGKILL
// the whole tree on timeout. Port of fs-mcp/internal/runtime/exec.go.
//
// Returns combined behaviour: stdout/stderr captured, exit code, and whether
// the process timed out (TIMEOUT_KILLED = true → caller should surface that).
//
// stdin is closed immediately so subprocesses that probe TTY (e.g. gh asking
// for login) fail fast instead of hanging. GIT_TERMINAL_PROMPT=0 is set on
// every spawn to make sure git never tries to prompt for credentials.

import { spawn, type SpawnOptions } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  elapsedMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number; // truncate captured streams beyond this
  input?: string;    // optional stdin payload (used by jq/yq expression-from-stdin)
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB cap on captured streams

export function execTool(
  command: string,
  args: string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...opts.env,
        GIT_TERMINAL_PROMPT: '0',
        GH_PROMPT_DISABLED: '1',
      },
      detached: true,    // own process group → SIGKILL kills children too
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    const child = spawn(command, args, spawnOpts);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncatedOut = false;
    let truncatedErr = false;
    let timedOut = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= maxBytes) {
        truncatedOut = true;
        return;
      }
      const room = maxBytes - stdout.length;
      stdout = Buffer.concat([stdout, chunk.subarray(0, room)]);
      if (chunk.length > room) truncatedOut = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= maxBytes) {
        truncatedErr = true;
        return;
      }
      const room = maxBytes - stderr.length;
      stderr = Buffer.concat([stderr, chunk.subarray(0, room)]);
      if (chunk.length > room) truncatedErr = true;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group, not just the leader.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const out = stdout.toString('utf8') + (truncatedOut ? '\n[truncated]' : '');
      const err = stderr.toString('utf8') + (truncatedErr ? '\n[truncated]' : '');
      resolve({
        stdout: out,
        stderr: err,
        code,
        signal,
        timedOut,
        elapsedMs: Date.now() - start,
      });
    });

    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

export function isOk(r: ExecResult): boolean {
  return r.code === 0 && !r.timedOut;
}

export function formatError(r: ExecResult): string {
  if (r.timedOut) return `timed out after ${r.elapsedMs}ms`;
  if (r.code !== 0) return `exit ${r.code}${r.signal ? ` (signal ${r.signal})` : ''}: ${r.stderr.trim() || r.stdout.trim() || '<no stderr>'}`;
  return 'ok';
}
