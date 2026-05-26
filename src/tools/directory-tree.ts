// directory_tree tool — recursive listing with sensible defaults.
// Port of fs-mcp/internal/tools/tree.go (simplified — single workspace root,
// auto-depth cap, configurable skip set).

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
  include_ignored: z.boolean().optional().describe('default false; when true, bypass the built-in skip set (node_modules, .git, dist, build, .venv, vendor, etc.) and walk everything'),
  extra_skip: z.array(z.string()).optional().describe('additional directory names to skip, appended to the default skip set'),
};

// Default skip set — directory names elided during recursion unless include_ignored=true.
// Curated for common noise: VCS, package managers, build artifacts, virtualenvs, editor metadata.
const DEFAULT_SKIP_NAMES = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__',
  'target', 'dist', 'build', '.next', '.cache', '.pytest_cache',
  '.mypy_cache', '.tox', '.gradle', '.idea', '.vscode',
  '.ruff_cache', 'vendor', '.terraform', 'coverage',
  '.nuxt', '.svelte-kit', '.turbo', '.yarn', '.pnpm-store',
  '_build', 'bin', 'obj', '.dart_tool', '.pub-cache',
  '.bundle', 'Pods', 'DerivedData',
]);

const MAX_ENTRIES = 2000;

interface TreeOpts {
  maxDepth: number;
  includeFiles: boolean;
  showSizes: boolean;
  skipSet: Set<string>;
  skippedDirs: Set<string>;
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
    // Skip check applies on CHILDREN only — the entry path itself is always walked,
    // so explicit `path: node_modules/lodash` still descends.
    if (ent.isDirectory() && opts.skipSet.has(ent.name)) {
      opts.skippedDirs.add(ent.name);
      continue;
    }
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

      // Build effective skip set:
      //   include_ignored=true → empty (walk everything)
      //   else → DEFAULT_SKIP_NAMES ∪ extra_skip
      let skipSet: Set<string>;
      if (input.include_ignored === true) {
        skipSet = new Set();
      } else {
        skipSet = new Set(DEFAULT_SKIP_NAMES);
        if (Array.isArray(input.extra_skip)) {
          for (const name of input.extra_skip) {
            if (typeof name === 'string' && name.length > 0) skipSet.add(name);
          }
        }
      }

      const opts: TreeOpts = {
        maxDepth: input.max_depth ?? 3,
        includeFiles: input.include_files !== false,
        showSizes: input.show_sizes === true,
        skipSet,
        skippedDirs: new Set(),
      };
      const out: string[] = [];
      out.push(`${basename(absPath) || workspace.repo}/`);
      await walk(absPath, '  ', 0, opts, out);

      const skippedDirs = [...opts.skippedDirs].sort();
      const treeText = out.join('\n');
      const payload = skippedDirs.length > 0
        ? `${treeText}\n\nskipped_dirs: ${JSON.stringify(skippedDirs)}`
        : treeText;

      return {
        content: [{ type: 'text' as const, text: payload }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `directory_tree error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };
}
