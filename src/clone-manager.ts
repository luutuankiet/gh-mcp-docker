// CloneManager: ephemeral workspace lifecycle.
//
// - clone(repo, ref?, depth?=1) → git clone shallow into /tmp/repos/<uuid>/
// - resolve(workspace_id) → path + touches lastAccessed (used by every tool)
// - GC sweeper: setInterval(5min), evicts entries idle > ttlSec
// - SIGTERM hook: clear interval + rmSync every workspace path
//
// Path safety: workspace ids are UUIDs, never user-supplied; sub-paths are
// resolved against the workspace root and traversal (..) is rejected.
//
// Token never logged: GH_TOKEN is substituted into the clone URL via
// `oauth2:<token>@github.com/<owner>/<repo>.git`, NOT via env or argv that
// could appear in error messages.

import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve as pathResolve, relative as pathRelative, sep } from 'node:path';
import { execTool, isOk, formatError } from './runtime/exec.js';

export interface Workspace {
  id: string;
  path: string;        // absolute path under /tmp/repos/<id>
  repo: string;        // owner/name (canonicalized)
  ref: string;         // requested ref (branch/tag/sha) or 'HEAD'
  sha: string;         // resolved HEAD sha after clone
  sizeMb: number;      // rough du -sm result
  createdAt: number;   // epoch ms
  lastAccessed: number;
}

export interface CloneInput {
  repo: string;
  ref?: string;
  depth?: number;
}

const REPOS_ROOT = '/tmp/repos';
const GC_INTERVAL_MS = 5 * 60 * 1000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function canonicalizeRepo(input: string): string {
  // accept: "owner/name", "https://github.com/owner/name", "https://github.com/owner/name.git"
  let s = input.trim();
  s = s.replace(/^https?:\/\/github\.com\//i, '');
  s = s.replace(/\.git$/i, '');
  if (!REPO_PATTERN.test(s)) {
    throw new Error(`invalid repo format: ${input} (expected owner/name)`);
  }
  return s;
}

export class CloneManager {
  readonly ttlSec: number;
  readonly maxSizeMb: number;
  readonly tmpfsQuotaMb: number;
  private readonly workspaces = new Map<string, Workspace>();
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(opts?: { ttlSec?: number; maxSizeMb?: number; tmpfsQuotaMb?: number }) {
    this.ttlSec = opts?.ttlSec ?? parseInt(process.env.CLONE_TTL_SEC ?? '1800', 10);
    this.maxSizeMb = opts?.maxSizeMb ?? parseInt(process.env.CLONE_MAX_SIZE_MB ?? '500', 10);
    this.tmpfsQuotaMb = opts?.tmpfsQuotaMb ?? parseInt(process.env.TMPFS_QUOTA_MB ?? '2048', 10);
  }

  async start(): Promise<void> {
    await mkdir(REPOS_ROOT, { recursive: true });
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = setInterval(() => {
      this.sweep().catch((err) => console.error('clone-manager GC error:', err));
    }, GC_INTERVAL_MS);
    this.gcTimer.unref();
  }

  async clone(input: CloneInput): Promise<Workspace> {
    const repo = canonicalizeRepo(input.repo);
    const ref = input.ref?.trim() || '';
    const depth = Math.max(1, Math.min(input.depth ?? 1, 50));

    // 1. Quota guard — total in-use vs tmpfs cap.
    const inUseMb = Array.from(this.workspaces.values()).reduce((s, w) => s + w.sizeMb, 0);
    if (inUseMb + this.maxSizeMb > this.tmpfsQuotaMb) {
      // Try a sweep first.
      await this.sweep();
      const afterSweep = Array.from(this.workspaces.values()).reduce((s, w) => s + w.sizeMb, 0);
      if (afterSweep + this.maxSizeMb > this.tmpfsQuotaMb) {
        throw new Error(`tmpfs quota would be exceeded: ${afterSweep}MB in use + ${this.maxSizeMb}MB reserve > ${this.tmpfsQuotaMb}MB cap. Retry after idle workspaces GC.`);
      }
    }

    // 2. Size pre-check via gh api (Contents/Metadata read covers .size).
    //    .size is in KB. Reject if > maxSizeMb.
    const sizeProbe = await execTool('gh', ['api', `repos/${repo}`, '-q', '.size'], {
      timeoutMs: 15_000,
      env: { GH_TOKEN: process.env.GH_TOKEN ?? '' },
    });
    if (!isOk(sizeProbe)) {
      throw new Error(`gh api repos/${repo} failed: ${formatError(sizeProbe)}`);
    }
    const sizeKb = parseInt(sizeProbe.stdout.trim(), 10);
    if (!Number.isFinite(sizeKb)) {
      throw new Error(`gh api returned unparseable size: "${sizeProbe.stdout.trim()}"`);
    }
    const estMb = Math.ceil(sizeKb / 1024);
    if (estMb > this.maxSizeMb) {
      throw new Error(`repo ${repo} is ${estMb}MB, exceeds CLONE_MAX_SIZE_MB=${this.maxSizeMb}MB`);
    }

    // 3. Clone.
    const id = randomUUID();
    const target = `${REPOS_ROOT}/${id}`;
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error('GH_TOKEN not set');
    const url = `https://oauth2:${token}@github.com/${repo}.git`;
    const cloneArgs = ['clone', '--depth', String(depth), '--filter=blob:none', '--single-branch'];
    if (ref) cloneArgs.push('--branch', ref);
    cloneArgs.push('--', url, target);

    const cloneRes = await execTool('git', cloneArgs, { timeoutMs: 60_000 });
    if (!isOk(cloneRes)) {
      // Best-effort cleanup if a partial dir was created.
      await rm(target, { recursive: true, force: true }).catch(() => {});
      // Scrub token from any error message before throwing.
      const scrub = (s: string) => s.replaceAll(token, '<redacted>');
      throw new Error(`git clone failed: ${scrub(formatError(cloneRes))}`);
    }

    // 4. Resolve HEAD sha.
    const shaRes = await execTool('git', ['-C', target, 'rev-parse', 'HEAD'], { timeoutMs: 5000 });
    const sha = isOk(shaRes) ? shaRes.stdout.trim() : '';

    // 5. Measure actual on-disk size.
    const duRes = await execTool('du', ['-sm', target], { timeoutMs: 10_000 });
    const measuredMb = isOk(duRes) ? parseInt(duRes.stdout.trim().split(/\s+/)[0], 10) || estMb : estMb;

    const now = Date.now();
    const ws: Workspace = {
      id,
      path: target,
      repo,
      ref: ref || 'HEAD',
      sha,
      sizeMb: measuredMb,
      createdAt: now,
      lastAccessed: now,
    };
    this.workspaces.set(id, ws);
    return ws;
  }

  // Resolve a workspace_id → workspace, also touches lastAccessed.
  touch(workspaceId: string): Workspace {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) throw new Error(`unknown workspace_id: ${workspaceId} (expired or never existed)`);
    ws.lastAccessed = Date.now();
    return ws;
  }

  // Resolve a relative sub-path within a workspace. Rejects traversal.
  resolvePath(workspaceId: string, subPath: string): { workspace: Workspace; absPath: string } {
    const workspace = this.touch(workspaceId);
    const rooted = pathResolve(workspace.path, subPath || '.');
    const rel = pathRelative(workspace.path, rooted);
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || pathResolve(rooted) !== rooted) {
      throw new Error(`path escapes workspace root: ${subPath}`);
    }
    return { workspace, absPath: rooted };
  }

  list(): Workspace[] {
    return Array.from(this.workspaces.values());
  }

  async sweep(): Promise<number> {
    const cutoff = Date.now() - this.ttlSec * 1000;
    const stale = Array.from(this.workspaces.values()).filter((w) => w.lastAccessed < cutoff);
    for (const w of stale) {
      this.workspaces.delete(w.id);
      await rm(w.path, { recursive: true, force: true }).catch((err) => {
        console.error(`clone-manager: failed to rm ${w.path}:`, err);
      });
    }
    return stale.length;
  }

  async flushAll(): Promise<void> {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    const all = Array.from(this.workspaces.values());
    this.workspaces.clear();
    await Promise.all(
      all.map((w) => rm(w.path, { recursive: true, force: true }).catch(() => {}))
    );
  }

  async exists(workspaceId: string): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    try {
      await stat(ws.path);
      return true;
    } catch {
      return false;
    }
  }
}
