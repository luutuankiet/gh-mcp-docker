// directory_tree tool — recursive listing with sensible defaults.
// Port of fs-mcp/internal/tools/tree.go (simplified — single workspace root,
// auto-depth cap, fixed skip set).

import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { CloneManager } from '../clone-manager.js';

export const directoryTreeSchema = {
  workspace_id: z.string(),
  path: z.string().optional().describe('sub-path within workspace (default: workspace root)'),
  max_depth: z.number().int().positive().max(10).optional().describe('default 3'),
  include_files: z.boolean().optional().describe('default true'),
  show_sizes: z.boolean().optional(),
};

const SKIP_NAMES = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__',
  'target', 'dist', 'build', '.next', '.cache', '.pytest_cache',
  '.mypy_cache', '.tox', '.gradle', '.idea', '.vscode',
]);

const MAX_ENTRIES = 2000;

interface TreeOpts {
  maxDepth: number;
  includeFiles: boolean;
  showSizes: boolean;
}

async function walk(dir: string, prefix: string, depth: number, opts: TreeOpts, out: string[]): Promise<boolean> {
  if (depth >= opts.maxDepth) return true;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of entries) {
    if (SKIP_NAMES.has(ent.name)) continue;
    if (out.length >= MAX_ENTRIES) {
      out.push(`${prefix}… [truncated at ${MAX_ENTRIES} entries]`);
      return false;
    }
    if (ent.isDirectory()) {
      out.push(`${prefix}${ent.name}/`);
      const ok = await walk(join(dir, ent.name), prefix + '  ', depth + 1, opts, out);
      if (!ok) return false;
    } else if (ent.isFile() && opts.includeFiles) {
      let label = ent.name;
      if (opts.showSizes) {
        try {
          const st = await stat(join(dir, ent.name));
          label += ` (${st.size}B)`;
        } catch {}
      }
      out.push(`${prefix}${label}`);
    }
  }
  return true;
}

export function makeDirectoryTreeHandler(manager: CloneManager) {
  return async (input: any) => {
    try {
      const { workspace, absPath } = manager.resolvePath(input.workspace_id, input.path || '.');
      const opts: TreeOpts = {
        maxDepth: input.max_depth ?? 3,
        includeFiles: input.include_files !== false,
        showSizes: input.show_sizes === true,
      };
      const out: string[] = [];
      out.push(`${basename(absPath) || workspace.repo}/`);
      await walk(absPath, '  ', 0, opts, out);
      return {
        content: [{ type: 'text' as const, text: out.join('\n') }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `directory_tree error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };
}
