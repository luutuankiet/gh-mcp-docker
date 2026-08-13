// CloneManager: ephemeral workspace lifecycle.
//
// - clone(repo, ref?, depth?=1) -> git clone shallow into /tmp/repos/<uuid>/
//   Identical (repo, ref, depth) requests inside CLONE_REUSE_WINDOW_SEC reuse the
//   live workspace instead of cloning a second copy. Every tool that consumes a
//   workspace is read-only, so sharing is safe, and it stops N parallel clients
//   from materialising N identical copies of the same repo.
// - resolve(workspace_id) -> path + touches lastAccessed (used by every tool)
// - GC sweeper: setInterval(5min) -> sweep() = TTL eviction + filesystem reconcile
// - SIGTERM hook: clear interval + rm every workspace path (awaited by the caller)
//
// BUDGET MODEL (the load-bearing part):
//   /tmp/repos is a tmpfs. tmpfs pages are charged to the container's memory
//   cgroup as `shmem` and are NOT reclaimable under pressure the way page cache
//   is. Workspace bytes therefore ARE container memory, one-for-one. Two
//   consequences drive the code below:
//     1. Admission is measured with statfs against the real mount, not by summing
//        remembered per-workspace sizes (which drift and miss orphans).
//     2. A clone that would exceed the budget evicts least-recently-used
//        workspaces to make room instead of failing the caller. Only a repo that
//        cannot fit even in an empty tmpfs is rejected outright.
//   Invariant the deployment must uphold:
//     container memory limit >= tmpfs size + node heap headroom + page cache headroom
//
// Path safety: workspace ids are UUIDs, never user-supplied; sub-paths are
// resolved against the workspace root and traversal (..) is rejected.
//
// Token never logged: GH_TOKEN is substituted into the clone URL via
// `oauth2:<token>@github.com/<owner>/<repo>.git`, NOT via env or argv that
// could appear in error messages.

import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, readdir, statfs } from 'node:fs/promises';
import { resolve as pathResolve, relative as pathRelative, sep } from 'node:path';
import { execTool, isOk, formatError } from './runtime/exec.js';

export interface Workspace {
  id: string;
  path: string;        // absolute path under /tmp/repos/<id>
  repo: string;        // owner/name (canonicalized)
  ref: string;         // requested ref (branch/tag/sha) or 'HEAD'
  depth: number;       // clone depth actually used (reuse must match)
  sha: string;         // resolved HEAD sha after clone
  sizeMb: number;      // rough du -sm result
  createdAt: number;   // epoch ms
  lastAccessed: number;
  reuseCount: number;  // how many times a clone request was served from this ws
}

export interface CloneInput {
  repo: string;
  ref?: string;
  depth?: number;
}

export interface BudgetSnapshot {
  tmpfsUsedMb: number;
  tmpfsQuotaMb: number;
  trackedMb: number;
  workspaceCount: number;
}

const REPOS_ROOT = '/tmp/repos';
const GC_INTERVAL_MS = 5 * 60 * 1000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Only ever reclaim directories that look like ids we minted. Anything else in
// the mount is left alone rather than blindly deleted.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  readonly reuseWindowSec: number;
  private readonly workspaces = new Map<string, Workspace>();
  // Ids whose directory exists on disk but is not yet a committed workspace.
  // Without this the reconcile sweep would delete an in-flight clone.
  private readonly pending = new Set<string>();
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(opts?: {
    ttlSec?: number;
    maxSizeMb?: number;
    tmpfsQuotaMb?: number;
    reuseWindowSec?: number;
  }) {
    this.ttlSec = opts?.ttlSec ?? parseInt(process.env.CLONE_TTL_SEC ?? '1800', 10);
    this.maxSizeMb = opts?.maxSizeMb ?? parseInt(process.env.CLONE_MAX_SIZE_MB ?? '350', 10);
    this.tmpfsQuotaMb = opts?.tmpfsQuotaMb ?? parseInt(process.env.TMPFS_QUOTA_MB ?? '448', 10);
    this.reuseWindowSec =
      opts?.reuseWindowSec ?? parseInt(process.env.CLONE_REUSE_WINDOW_SEC ?? '300', 10);
  }

  async start(): Promise<void> {
    await mkdir(REPOS_ROOT, { recursive: true });
    // A previous process incarnation may have died without flushing. The mount
    // survives a bare process restart (it only goes away when the container is
    // recreated), so reclaim anything left behind before serving traffic.
    const orphans = await this.reconcile();
    if (orphans > 0) {
      console.log(`clone-manager: reclaimed ${orphans} orphaned workspace dir(s) at boot`);
    }
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = setInterval(() => {
      this.sweep().catch((err) => console.error('clone-manager GC error:', err));
    }, GC_INTERVAL_MS);
    this.gcTimer.unref();
  }

  // Real bytes resident in the tmpfs, including orphans and post-clone growth.
  // Falls back to the sum of remembered sizes if statfs is unavailable.
  async usedMb(): Promise<number> {
    try {
      const fsStat = await statfs(REPOS_ROOT);
      const used = (Number(fsStat.blocks) - Number(fsStat.bfree)) * Number(fsStat.bsize);
      return Math.ceil(used / (1024 * 1024));
    } catch {
      return this.trackedMb();
    }
  }

  trackedMb(): number {
    return Array.from(this.workspaces.values()).reduce((s, w) => s + w.sizeMb, 0);
  }

  async budget(): Promise<BudgetSnapshot> {
    return {
      tmpfsUsedMb: await this.usedMb(),
      tmpfsQuotaMb: this.tmpfsQuotaMb,
      trackedMb: this.trackedMb(),
      workspaceCount: this.workspaces.size,
    };
  }

  private async destroy(ws: Workspace): Promise<void> {
    this.workspaces.delete(ws.id);
    await rm(ws.path, { recursive: true, force: true }).catch((err) => {
      console.error(`clone-manager: failed to rm ${ws.path}:`, err);
    });
  }

  // Delete UUID-shaped directories that no live workspace claims. This is what
  // makes the sweeper self-healing: without it, any directory that fell out of
  // the map (crash, failed rm, pre-restart leftovers) pins tmpfs pages forever
  // with nothing left to evict it.
  private async reconcile(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(REPOS_ROOT);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of entries) {
      if (!UUID_PATTERN.test(name)) continue;
      if (this.workspaces.has(name) || this.pending.has(name)) continue;
      try {
        await rm(`${REPOS_ROOT}/${name}`, { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.error(`clone-manager: failed to rm orphan ${name}:`, err);
      }
    }
    return removed;
  }

  // Evict least-recently-used workspaces until `needMb` fits under the quota.
  // Returns the number evicted.
  private async evictLru(needMb: number): Promise<number> {
    let evicted = 0;
    const byIdle = Array.from(this.workspaces.values()).sort(
      (a, b) => a.lastAccessed - b.lastAccessed
    );
    for (const ws of byIdle) {
      if ((await this.usedMb()) + needMb <= this.tmpfsQuotaMb) break;
      console.log(
        `clone-manager: LRU-evicting ${ws.id} (${ws.repo}, ${ws.sizeMb}MB, idle ${Math.floor((Date.now() - ws.lastAccessed) / 1000)}s) to admit ${needMb}MB`
      );
      await this.destroy(ws);
      evicted++;
    }
    return evicted;
  }

  // Make `needMb` of room: TTL sweep -> orphan reconcile -> LRU eviction.
  private async makeRoom(needMb: number): Promise<void> {
    if ((await this.usedMb()) + needMb <= this.tmpfsQuotaMb) return;
    await this.sweep();
    if ((await this.usedMb()) + needMb <= this.tmpfsQuotaMb) return;
    await this.evictLru(needMb);
    const used = await this.usedMb();
    if (used + needMb > this.tmpfsQuotaMb) {
      throw new Error(
        `cannot admit ${needMb}MB clone: ${used}MB still in use against a ${this.tmpfsQuotaMb}MB tmpfs budget after GC, orphan reclaim and LRU eviction. The repo is too large for this deployment.`
      );
    }
  }

  async clone(input: CloneInput): Promise<Workspace> {
    const repo = canonicalizeRepo(input.repo);
    const ref = input.ref?.trim() || '';
    const depth = Math.max(1, Math.min(input.depth ?? 1, 50));
    const refKey = ref || 'HEAD';

    // 1. Dedup. Parallel clients researching the same repo share one checkout
    //    rather than each paying for a private copy.
    if (this.reuseWindowSec > 0) {
      const candidate = Array.from(this.workspaces.values()).find(
        (w) =>
          w.repo === repo &&
          w.ref === refKey &&
          w.depth === depth &&
          Date.now() - w.createdAt < this.reuseWindowSec * 1000
      );
      if (candidate && (await this.exists(candidate.id))) {
        candidate.lastAccessed = Date.now();
        candidate.reuseCount++;
        console.log(
          `clone-manager: reusing workspace ${candidate.id} for ${repo}@${refKey} (reuse #${candidate.reuseCount})`
        );
        return candidate;
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

    // 3. Admission against the REAL tmpfs, reserving this repo's estimate plus a
    //    small margin for checkout overhead -- not the worst-case per-repo cap,
    //    which would let one reservation swallow the entire budget.
    const reserveMb = Math.max(16, Math.ceil(estMb * 1.2));
    await this.makeRoom(reserveMb);

    // 4. Clone.
    const id = randomUUID();
    const target = `${REPOS_ROOT}/${id}`;
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error('GH_TOKEN not set');
    const url = `https://oauth2:${token}@github.com/${repo}.git`;
    const cloneArgs = [
      'clone',
      '--depth',
      String(depth),
      '--filter=blob:none',
      '--single-branch',
      '--no-tags',
    ];
    if (ref) cloneArgs.push('--branch', ref);
    cloneArgs.push('--', url, target);

    this.pending.add(id);
    let cloneRes;
    try {
      cloneRes = await execTool('git', cloneArgs, { timeoutMs: 60_000 });
    } finally {
      this.pending.delete(id);
    }
    if (!isOk(cloneRes)) {
      // Best-effort cleanup if a partial dir was created.
      await rm(target, { recursive: true, force: true }).catch(() => {});
      // Scrub token from any error message before throwing.
      const scrub = (s: string) => s.replaceAll(token, '<redacted>');
      throw new Error(`git clone failed: ${scrub(formatError(cloneRes))}`);
    }

    // 5. Resolve HEAD sha.
    const shaRes = await execTool('git', ['-C', target, 'rev-parse', 'HEAD'], { timeoutMs: 5000 });
    const sha = isOk(shaRes) ? shaRes.stdout.trim() : '';

    // 6. Measure actual on-disk size.
    const duRes = await execTool('du', ['-sm', target], { timeoutMs: 10_000 });
    const measuredMb = isOk(duRes) ? parseInt(duRes.stdout.trim().split(/\s+/)[0], 10) || estMb : estMb;

    const now = Date.now();
    const ws: Workspace = {
      id,
      path: target,
      repo,
      ref: refKey,
      depth,
      sha,
      sizeMb: measuredMb,
      createdAt: now,
      lastAccessed: now,
      reuseCount: 0,
    };
    this.workspaces.set(id, ws);
    return ws;
  }

  // Resolve a workspace_id -> workspace, also touches lastAccessed.
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

  // TTL eviction followed by orphan reclaim. Returns total directories removed.
  async sweep(): Promise<number> {
    const cutoff = Date.now() - this.ttlSec * 1000;
    const stale = Array.from(this.workspaces.values()).filter((w) => w.lastAccessed < cutoff);
    for (const w of stale) {
      await this.destroy(w);
    }
    const orphans = await this.reconcile();
    if (stale.length || orphans) {
      console.log(
        `clone-manager: swept ${stale.length} expired + ${orphans} orphaned workspace(s); ${await this.usedMb()}MB / ${this.tmpfsQuotaMb}MB in use`
      );
    }
    return stale.length + orphans;
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
    await this.reconcile().catch(() => 0);
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
