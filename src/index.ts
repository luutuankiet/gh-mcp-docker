#!/usr/bin/env node

// Suppress punycode deprecation noise on Node 22.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && warning.message.includes('punycode')) {
    return;
  }
  console.warn(warning.message);
});

import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from 'dotenv';

import { CloneManager } from './clone-manager.js';
import { cloneRepoSchema, makeCloneRepoHandler } from './tools/clone-repo.js';
import { grepSchema, makeGrepHandler } from './tools/grep.js';
import { readFilesSchema, makeReadFilesHandler } from './tools/read-files.js';
import { directoryTreeSchema, makeDirectoryTreeHandler } from './tools/directory-tree.js';
import { jqSchema, makeJqHandler } from './tools/jq.js';
import { yqSchema, makeYqHandler } from './tools/yq.js';
import { ghApiSchema, ghApiHandler } from './tools/gh-api.js';

config();

const cloneManager = new CloneManager();

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'gh-cli-mcp',
    version: '0.2.0',
  });

  server.registerTool(
    'clone_repo',
    {
      title: 'Clone GitHub Repo',
      description: 'Clone a GitHub repository into an ephemeral workspace. Returns a workspace_id used by other tools. Workspaces are GC\'d after CLONE_TTL_SEC of idleness.',
      inputSchema: cloneRepoSchema,
    },
    makeCloneRepoHandler(cloneManager) as any
  );

  server.registerTool(
    'grep',
    {
      title: 'Ripgrep with Section Hints',
      description: 'ripgrep regex search inside a cloned workspace. Returns matches with section_end_hint that chains directly into read_files as end_line. By default respects .gitignore AND skips a built-in noise set (node_modules, vendor, dist, build, target, .venv, __pycache__, etc.). Set no_ignore=true for raw rg semantics, or hidden=true to include dot-prefixed files while keeping the defaults.',
      inputSchema: grepSchema,
    },
    makeGrepHandler(cloneManager) as any
  );

  server.registerTool(
    'read_files',
    {
      title: 'Multi-Slice Batched Read',
      description: 'Read one or more files from a workspace with offset/limit/tail/read_to_next_pattern slicing. Batches multiple files and multiple slices per file.',
      inputSchema: readFilesSchema,
    },
    makeReadFilesHandler(cloneManager) as any
  );

  server.registerTool(
    'directory_tree',
    {
      title: 'Recursive Directory Tree',
      description: 'Recursive directory listing of a workspace path. Auto-caps max_depth. By default skips a built-in noise set (.git, node_modules, dist, build, target, .venv, vendor, __pycache__, .next, etc.). Set include_ignored=true to walk everything, or pass extra_skip to append more directory names. Skipped names actually encountered are echoed back in the response.',
      inputSchema: directoryTreeSchema,
    },
    makeDirectoryTreeHandler(cloneManager) as any
  );

  server.registerTool(
    'jq',
    {
      title: 'JSON Query (jq)',
      description: 'Run a jq expression against a JSON file in the workspace. Returns compact JSON output.',
      inputSchema: jqSchema,
    },
    makeJqHandler(cloneManager) as any
  );

  server.registerTool(
    'yq',
    {
      title: 'Structured Data Query (yq)',
      description: 'Run a yq expression against YAML/JSON/XML/TOML/CSV/TSV/INI/HCL files. Use input_format: "xml" for .twb / GitHub Actions XML configs.',
      inputSchema: yqSchema,
    },
    makeYqHandler(cloneManager) as any
  );

  server.registerTool(
    'gh_api',
    {
      title: 'GitHub API (GET-only)',
      description: 'Read-only GitHub API passthrough via gh CLI. Accepts a relative API path (e.g. "repos/owner/repo", "search/code?q=foo+repo:bar"). Method overrides and write fields are rejected.',
      inputSchema: ghApiSchema,
    },
    ghApiHandler as any
  );

  return server;
}

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).send('ok');
});

app.get('/workspaces', (_req: Request, res: Response) => {
  // Diagnostic endpoint — NOT MCP; useful for ops smoke.
  res.status(200).json({
    count: cloneManager.list().length,
    workspaces: cloneManager.list().map((w) => ({
      id: w.id,
      repo: w.repo,
      ref: w.ref,
      size_mb: w.sizeMb,
      idle_sec: Math.floor((Date.now() - w.lastAccessed) / 1000),
    })),
    ttl_sec: cloneManager.ttlSec,
  });
});

app.post('/mcp', async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = buildServer();

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

const rejectStateless = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method Not Allowed (stateless mode)' },
    id: null,
  });
};
app.get('/mcp', rejectStateless);
app.delete('/mcp', rejectStateless);

const PORT = parseInt(process.env.PORT ?? '8000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  await cloneManager.start();
  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`gh-cli-mcp listening on http://${HOST}:${PORT}/mcp (stateless StreamableHTTP)`);
    console.log(`clone TTL ${cloneManager.ttlSec}s, max repo ${cloneManager.maxSizeMb}MB, tmpfs quota ${cloneManager.tmpfsQuotaMb}MB`);
  });

  function shutdown(signal: string) {
    console.log(`Received ${signal}, shutting down...`);
    cloneManager.flushAll().catch((err) => console.error('flushAll error:', err));
    httpServer.close(() => {
      console.log('HTTP server closed, exiting');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Shutdown timeout exceeded, force-exiting');
      process.exit(1);
    }, 5000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('boot failed:', err);
  process.exit(1);
});
