import { z } from 'zod';
import type { CloneManager } from '../clone-manager.js';

export const cloneRepoSchema = {
  repo: z.string().describe('owner/name or full GitHub URL'),
  ref: z.string().optional().describe('branch, tag, or SHA (default: repo default branch)'),
  depth: z.number().int().positive().optional().describe('shallow clone depth (default 1, max 50)'),
};

export function makeCloneRepoHandler(manager: CloneManager) {
  return async (input: { repo: string; ref?: string; depth?: number }) => {
    try {
      const ws = await manager.clone(input);
      const payload = {
        workspace_id: ws.id,
        repo: ws.repo,
        ref: ws.ref,
        sha: ws.sha,
        size_mb: ws.sizeMb,
        ttl_sec: manager.ttlSec,
        note: `Workspace will be GC'd after ${manager.ttlSec}s of idleness. Pass workspace_id to grep/read_files/directory_tree/jq/yq.`,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `clone_repo error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };
}
