// gh_api tool — GET-only passthrough to `gh api <path>`.
// No method override (no -X PATCH/POST/DELETE allowed).
// No workspace_id needed — hits the live GitHub API with the server's PAT.

import { z } from 'zod';
import { execTool, isOk } from '../runtime/exec.js';

export const ghApiSchema = {
  path: z.string().describe('GitHub API path, e.g. repos/owner/repo, repos/owner/repo/pulls/1, search/code?q=...'),
};

// Reject anything that smells like a method override or a write.
const FORBIDDEN_TOKENS = /(?:^|\s)(?:-X|--method|-F|--field|-f|--input)\b/i;

export async function ghApiHandler(input: { path: string }) {
  try {
    const p = input.path.trim();
    if (FORBIDDEN_TOKENS.test(p)) {
      return {
        content: [{ type: 'text' as const, text: 'gh_api: write-method tokens (-X, -F, --method, --field, --input) are not permitted' }],
        isError: true,
      };
    }
    if (!p || p.startsWith('-') || p.startsWith('/')) {
      return {
        content: [{ type: 'text' as const, text: 'gh_api: path must be a relative API path (e.g. repos/owner/repo)' }],
        isError: true,
      };
    }
    const res = await execTool('gh', ['api', p], {
      timeoutMs: 30_000,
      env: { GH_TOKEN: process.env.GH_TOKEN ?? '' },
    });
    if (!isOk(res)) {
      return {
        content: [{ type: 'text' as const, text: `gh_api error: ${res.stderr.trim() || res.stdout.trim()}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text' as const, text: res.stdout.trim() }] };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `gh_api error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
