// grep tool — ripgrep wrapper with section_end_hint chained to read_files.
// Port of fs-mcp/internal/tools/grep.go (simplified: no rtk integration,
// no broad-search safety rails for `/` since we operate inside cloned
// workspaces which are bounded by design).

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { CloneManager } from '../clone-manager.js';
import { execTool, isOk } from '../runtime/exec.js';

export const grepSchema = {
  workspace_id: z.string(),
  pattern: z.string().describe('ripgrep regex pattern'),
  path: z.string().optional().describe('sub-path within workspace (default: workspace root)'),
  glob: z.string().optional().describe("file glob, e.g. '*.go' or '!vendor/**'"),
  ignore_case: z.boolean().optional(),
  context: z.number().int().nonnegative().max(20).optional(),
  files_only: z.boolean().optional(),
  max_depth: z.number().int().positive().max(20).optional(),
  max_matches: z.number().int().positive().max(500).optional(),
  no_ignore: z.boolean().optional().describe('default false; when true, pass --no-ignore --hidden to ripgrep AND drop the default exclude glob (raw rg semantics, scans node_modules / dist / .git / etc.)'),
  hidden: z.boolean().optional().describe('default false; when true, include dot-prefixed files (--hidden) while keeping .gitignore respect and the default exclude glob'),
};

// Default section boundary regex — next func/class/def/interface/type/const/let/var/export/markdown-header.
// Match-anchored at start of line. Multi-language good-enough heuristic.
const SECTION_BOUNDARY = /^(?:(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum|struct|impl|trait|fn|def|public|private|protected|static)\b|#{1,4}\s)/;
const MAX_SECTION_LOOKAHEAD = 100;

// Belt-and-braces default exclude glob — layered ON TOP of ripgrep's .gitignore
// respect, so repos that committed noise (vendored deps, generated dirs) still
// stay quiet. Dropped entirely when no_ignore=true.
const DEFAULT_EXCLUDE_GLOB = '!**/{node_modules,vendor,dist,build,target,.venv,venv,__pycache__,.next,.nuxt,.svelte-kit,.turbo,.yarn,.pnpm-store,_build,bin,obj,coverage,Pods,DerivedData,.dart_tool,.pub-cache,.terraform,.cache,.ruff_cache,.tox,.gradle,.pytest_cache,.mypy_cache,.git,.idea,.vscode}/**';

async function findSectionEnd(absPath: string, startLine: number): Promise<number> {
  try {
    const text = await readFile(absPath, 'utf8');
    const lines = text.split('\n');
    const upto = Math.min(lines.length, startLine + MAX_SECTION_LOOKAHEAD);
    for (let i = startLine; i < upto; i++) {
      if (SECTION_BOUNDARY.test(lines[i])) return i; // 0-indexed = the line BEFORE
    }
    return upto;
  } catch {
    return startLine + 20;
  }
}

interface RgJsonMessage {
  type: 'match' | 'begin' | 'end' | 'summary';
  data: any;
}

export function makeGrepHandler(manager: CloneManager) {
  return async (input: any) => {
    try {
      const { workspace, absPath } = manager.resolvePath(input.workspace_id, input.path || '.');
      const args = ['--json', '--max-depth', String(input.max_depth ?? 8)];
      if (input.ignore_case) args.push('-i');

      // Noise reduction layering:
      //   no_ignore=true → raw rg: --no-ignore --hidden, no fallback glob
      //   hidden=true    → keep gitignore + fallback glob, include hidden files
      //   default        → gitignore respected + fallback glob applied
      if (input.no_ignore === true) {
        args.push('--no-ignore', '--hidden');
      } else {
        if (input.hidden === true) args.push('--hidden');
        args.push('--glob', DEFAULT_EXCLUDE_GLOB);
      }

      if (input.glob) args.push('--glob', input.glob);
      if (input.files_only) args.push('-l');
      if (input.context && input.context > 0) args.push('-C', String(input.context));
      const maxMatches = input.max_matches ?? 200;
      args.push('--max-count', String(maxMatches));
      args.push('--', input.pattern, absPath);

      const res = await execTool('rg', args, { timeoutMs: 30_000 });
      // rg exits 1 when no matches — not an error.
      if (res.code !== 0 && res.code !== 1) {
        return {
          content: [{ type: 'text' as const, text: `grep error: rg exit ${res.code}: ${res.stderr.trim() || res.stdout.trim()}` }],
          isError: true,
        };
      }

      if (input.files_only) {
        const files = res.stdout.split('\n').filter(Boolean).map((p) => p.replace(workspace.path + '/', ''));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ files, total: files.length }, null, 2) }],
        };
      }

      // Parse NDJSON, collect matches with section_end_hint.
      const matches: Array<{ path: string; line: number; text: string; section_end_hint: number }> = [];
      const lines = res.stdout.split('\n');
      let currentFile = '';
      for (const line of lines) {
        if (!line) continue;
        let msg: RgJsonMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'begin') {
          currentFile = msg.data.path?.text ?? '';
        } else if (msg.type === 'match' && currentFile) {
          const lineNo = msg.data.line_number as number;
          const matchText = (msg.data.lines?.text as string ?? '').replace(/\n$/, '');
          const sectionEnd = await findSectionEnd(currentFile, lineNo);
          const rel = currentFile.replace(workspace.path + '/', '');
          matches.push({
            path: rel,
            line: lineNo,
            text: matchText.length > 240 ? matchText.slice(0, 240) + '…' : matchText,
            section_end_hint: sectionEnd,
          });
          if (matches.length >= maxMatches) break;
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ matches, total: matches.length, truncated: matches.length >= maxMatches }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `grep error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };
}
