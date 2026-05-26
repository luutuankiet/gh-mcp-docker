import { z } from 'zod';
import type { CloneManager } from '../clone-manager.js';
import { execTool, isOk } from '../runtime/exec.js';

export const jqSchema = {
  workspace_id: z.string(),
  file: z.string(),
  expression: z.string().describe('jq expression, e.g. .dependencies | keys'),
};

export function makeJqHandler(manager: CloneManager) {
  return async (input: any) => {
    try {
      const { absPath } = manager.resolvePath(input.workspace_id, input.file);
      // Pass expression as positional arg; file as filename.
      const res = await execTool('jq', ['-c', input.expression, absPath], { timeoutMs: 15_000 });
      if (!isOk(res)) {
        return {
          content: [{ type: 'text' as const, text: `jq error: ${res.stderr.trim() || res.stdout.trim()}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: res.stdout.trim() }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `jq error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };
}
