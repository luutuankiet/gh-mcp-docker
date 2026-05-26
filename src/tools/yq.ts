import { z } from 'zod';
import type { CloneManager } from '../clone-manager.js';
import { execTool, isOk } from '../runtime/exec.js';

export const yqSchema = {
  workspace_id: z.string(),
  file: z.string(),
  expression: z.string().describe('yq expression (mikefarah syntax)'),
  input_format: z.enum(['yaml', 'json', 'xml', 'csv', 'tsv', 'toml', 'props', 'ini', 'hcl']).optional(),
};

export function makeYqHandler(manager: CloneManager) {
  return async (input: any) => {
    try {
      const { absPath } = manager.resolvePath(input.workspace_id, input.file);
      const args: string[] = [];
      if (input.input_format && input.input_format !== 'yaml') {
        args.push('-p', input.input_format === 'json' ? 'json' : input.input_format);
      }
      args.push(input.expression, absPath);
      const res = await execTool('yq', args, { timeoutMs: 15_000 });
      if (!isOk(res)) {
        return {
          content: [{ type: 'text' as const, text: `yq error: ${res.stderr.trim() || res.stdout.trim()}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: res.stdout.trim() }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `yq error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };
}
