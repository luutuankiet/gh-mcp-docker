// gh_api tool — passthrough to `gh api <path>` for read-side REST queries.
// Supports optional `jq` filter for in-process projection/aggregation — solves
// token bloat on noisy endpoints like /actions/runs and /pulls (25+ fields per
// item × N items can blow past 30k tokens).
//
// For writes (POST/PATCH/DELETE) or multi-flag gh-api invocations, use the
// general `gh` tool instead, e.g.:
//   gh args=["api","repos/.../issues","-X","POST","-f","title=foo"]
//
// v0.3.0 charter pivot: FORBIDDEN_TOKENS regex dropped. PAT scope is the
// entire policy boundary — the server no longer pre-blocks write tokens.

import { z } from 'zod';
import { execTool, isOk } from '../runtime/exec.js';

export const ghApiSchema = {
  path: z.string().describe('GitHub API path (relative, no leading slash), e.g. "repos/owner/repo", "repos/owner/repo/actions/runs?per_page=10", "search/code?q=foo+repo:bar".'),
  jq: z.string().optional().describe('Optional jq filter applied to the response body before return. Example: "[.workflow_runs[] | {id, name, conclusion, head_branch}]" projects a noisy /actions/runs response to ~4 fields per run. Output passes through `jq -c` (compact). Omit for verbatim response.'),
};

export async function ghApiHandler(input: { path: string; jq?: string }) {
  try {
    const p = input.path.trim();
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

    // No jq filter -> return verbatim.
    if (!input.jq) {
      return { content: [{ type: 'text' as const, text: res.stdout.trim() }] };
    }

    // Pipe gh stdout through `jq -c <filter>` via stdin.
    const jqRes = await execTool('jq', ['-c', input.jq], {
      timeoutMs: 15_000,
      input: res.stdout,
    });
    if (!isOk(jqRes)) {
      return {
        content: [{ type: 'text' as const, text: `gh_api jq filter error: ${jqRes.stderr.trim() || jqRes.stdout.trim()}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text' as const, text: jqRes.stdout.trim() }] };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `gh_api error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
