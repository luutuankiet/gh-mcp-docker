// read_files tool — multi-file, multi-slice batched read.
// Port of fs-mcp/internal/tools/read.go (text-only; no image passthrough
// per ARCHITECTURE.md decision: agents do read-only code exploration,
// images are out of scope).

import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import type { CloneManager } from '../clone-manager.js';

const sliceSchema = z.object({
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
  tail: z.number().int().positive().optional(),
  read_to_next_pattern: z.string().optional(),
});

export const readFilesSchema = {
  workspace_id: z.string(),
  files: z.array(z.object({
    path: z.string(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().nonnegative().optional(),
    tail: z.number().int().positive().optional(),
    read_to_next_pattern: z.string().optional(),
    reads: z.array(sliceSchema).optional(),
  })),
};

const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;

interface SliceSpec {
  offset?: number;
  limit?: number;
  tail?: number;
  read_to_next_pattern?: string;
}

interface SliceResult {
  start_line: number;
  end_line: number;
  content: string;
  truncated?: boolean;
}

function applySlice(allLines: string[], spec: SliceSpec): SliceResult {
  const totalLines = allLines.length;

  if (spec.tail !== undefined) {
    const start = Math.max(0, totalLines - spec.tail);
    return {
      start_line: start + 1,
      end_line: totalLines,
      content: allLines.slice(start).join('\n'),
    };
  }

  const offset0 = Math.max(0, (spec.offset ?? 1) - 1); // 1-indexed input → 0-indexed slice
  let endExclusive: number;

  if (spec.read_to_next_pattern !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(spec.read_to_next_pattern);
    } catch (e) {
      throw new Error(`invalid read_to_next_pattern: ${(e as Error).message}`);
    }
    let stop = totalLines;
    for (let i = offset0 + 1; i < totalLines; i++) {
      if (re.test(allLines[i])) { stop = i; break; }
    }
    endExclusive = stop;
  } else if (spec.limit !== undefined && spec.limit > 0) {
    endExclusive = Math.min(totalLines, offset0 + spec.limit);
  } else {
    endExclusive = totalLines;
  }

  return {
    start_line: offset0 + 1,
    end_line: endExclusive,
    content: allLines.slice(offset0, endExclusive).join('\n'),
  };
}

export function makeReadFilesHandler(manager: CloneManager) {
  return async (input: { workspace_id: string; files: Array<any> }) => {
    const out: any[] = [];
    for (const fileSpec of input.files) {
      try {
        const { absPath } = manager.resolvePath(input.workspace_id, fileSpec.path);
        const st = await stat(absPath);
        if (!st.isFile()) {
          out.push({ path: fileSpec.path, error: 'not a file' });
          continue;
        }
        if (st.size > MAX_BYTES_PER_FILE) {
          out.push({ path: fileSpec.path, error: `file too large (${st.size} bytes > ${MAX_BYTES_PER_FILE} cap)` });
          continue;
        }
        const text = await readFile(absPath, 'utf8');
        const lines = text.split('\n');

        const specs: SliceSpec[] = (fileSpec.reads && fileSpec.reads.length > 0)
          ? fileSpec.reads
          : [{
            offset: fileSpec.offset,
            limit: fileSpec.limit,
            tail: fileSpec.tail,
            read_to_next_pattern: fileSpec.read_to_next_pattern,
          }];

        const slices = specs.map((s) => applySlice(lines, s));
        out.push({ path: fileSpec.path, total_lines: lines.length, slices });
      } catch (err) {
        out.push({ path: fileSpec.path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ files: out }, null, 2) }],
    };
  };
}
