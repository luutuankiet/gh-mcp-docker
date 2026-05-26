// gh tool — faithful execution of any `gh <args>` invocation.
//
// PAT scope is the policy boundary. The server does not gate, filter, or
// restrict subcommands. Use this for orchestrated workflows:
//   gh release create v1.0.0 --notes "..."
//   gh pr create --title "..." --body "..." --base main
//   gh repo create owner/name --public --description "..."
//   gh workflow run release.yml --ref main
//   gh issue create --title "..." --body "..."
//
// For raw REST queries (especially with jq projection), prefer `gh_api`.
// v0.3.0 — added alongside the charter pivot from read-only to PAT-scoped.

import { z } from 'zod';
import { execTool, isOk } from '../runtime/exec.js';

export const ghSchema = {
  args: z
    .array(z.string())
    .min(1)
    .describe(
      'Argument vector passed faithfully to the `gh` CLI binary, e.g. ["release","create","v1.0.0","--notes","Release notes here"] or ["--version"]. No subcommand allowlist, no flag blocklist. Authority = PAT scope set on GH_TOKEN. Use `gh <subcommand> --help` to discover the surface. Writes (release create, repo create, workflow run, pr create, issue create, etc.) require the matching PAT scope (Contents:Write, Administration:Write, Actions:Write + workflow, Pull requests:Write, Issues:Write respectively) — GitHub returns 403 if missing.'
    ),
};

export async function ghHandler(input: { args: string[] }) {
  try {
    if (!Array.isArray(input.args) || input.args.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'gh: args must be a non-empty string array, e.g. ["--version"] or ["release","list"]',
          },
        ],
        isError: true,
      };
    }

    const res = await execTool('gh', input.args, {
      timeoutMs: 60_000,
      env: { GH_TOKEN: process.env.GH_TOKEN ?? '' },
    });

    // gh writes progress / confirmation lines to stderr (e.g. "✓ Created release v1.0.0")
    // and structured data to stdout. Surface both on success; surface both on error too
    // so 403/422 responses come back legibly.
    if (!isOk(res)) {
      const detail = [
        res.timedOut ? `timed out after ${res.elapsedMs}ms` : `exit ${res.code}`,
        res.stderr.trim() && `stderr: ${res.stderr.trim()}`,
        res.stdout.trim() && `stdout: ${res.stdout.trim()}`,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        content: [{ type: 'text' as const, text: `gh error:\n${detail}` }],
        isError: true,
      };
    }

    const stdout = res.stdout.trim();
    const stderr = res.stderr.trim();
    const combined = stderr
      ? stdout
        ? `${stdout}\n\n[stderr]\n${stderr}`
        : `[stderr]\n${stderr}`
      : stdout || '(no output)';
    return { content: [{ type: 'text' as const, text: combined }] };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `gh error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}
