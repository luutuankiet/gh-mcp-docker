# gh-cli-mcp-http

Self-hosted, read-only MCP server for **live GitHub codebase exploration**. Clone any repo on demand into an ephemeral workspace and let an agent grep / read / tree / jq / yq / gh-api its way around — no full-content fetch, no stale RAG snapshot.

## Why this exists

DeepWiki and similar tools index codebases periodically — agents always tap into a stale view. This server clones live from GitHub on demand. Tool surface is intentionally tight (read-only, no shell, no edit) so an agent can be pointed at an arbitrary repo URL and explore through token-efficient primitives.

v0.2.0 is a complete rewrite of the original `gh-mcp-docker` (a Python shell-wrapper of `gh` CLI exposed via supergateway). Native HTTP transport via the official `@modelcontextprotocol/sdk` — no `supergateway`, no stdio bridge, no per-request child spawn.

## Resource profile

Single Node process, no spawning beyond `git`/`gh`/`rg`/`jq`/`yq` subprocesses scoped to one request. Resting ~40 MiB. Burst (15 concurrent clones, 500 MiB cap each) bounded by the 2 GiB tmpfs and 256 MiB container limit. Workspaces GC after `CLONE_TTL_SEC` (default 30 min) of idleness; sweeper runs every 5 min.

## Quick start

```bash
cp .env.example .env
# edit .env: set GH_TOKEN (fine-grained PAT, Contents+Metadata read-only)
docker compose up -d --build
curl http://localhost:8000/healthz   # -> ok
```

MCP endpoint: `POST /mcp` (StreamableHTTP, stateless).

Connect from Claude Code:

```bash
claude mcp add --transport http gh-cli https://<user>:<password>@<your-host>/mcp
```

## Tools (7 read-only)

| name | purpose |
|---|---|
| `clone_repo` | Clone owner/repo into ephemeral workspace, return workspace_id |
| `grep` | ripgrep with auto section-end hints for follow-up reads |
| `read_files` | Multi-file, multi-slice batched read with offset/limit/tail/pattern |
| `directory_tree` | Recursive listing with auto-depth caps + ignore conventions |
| `jq` | JSON query against any workspace file |
| `yq` | YAML/XML/TOML/CSV/INI/HCL query (mikefarah's yq) |
| `gh_api` | GET-only `gh api <path>` passthrough, PAT-authenticated |

No edit. No bash. No `run_command` escape hatch. No language toolchains in the image. By design.

### Default ignore behavior

Both `directory_tree` and `grep` skip the typical noisy dirs (`node_modules`, `.git`, `dist`, `build`, `target`, `.venv`, `__pycache__`, `vendor`, `.next`, `.nuxt`, `.turbo`, `coverage`, `Pods`, `DerivedData`, lockfile caches, editor metadata, etc.) by default — the common case is a clean codebase walk, not a bytecode tour. Opt back in when you need it:

- `directory_tree`: set `include_ignored: true` to walk everything, or pass `extra_skip: ["foo", "bar"]` to append more names. The response echoes a `skipped_dirs` list of names actually encountered, so an agent can discover what it missed and re-call.
- `grep`: set `no_ignore: true` for raw `rg --no-ignore --hidden` semantics (also drops the default exclude glob); or `hidden: true` to include dot-prefixed files while keeping `.gitignore` respect and the default exclude glob. The default behavior also honors the workspace's `.gitignore`.
- Skip set applies on **recursion**, not on the entry path. If you explicitly target `path: node_modules/lodash`, the walk descends from there.

## Config

| env | default | purpose |
|---|---|---|
| `GH_TOKEN` | (required) | Fine-grained PAT, Contents+Metadata read-only |
| `PORT` | 8000 | HTTP bind port |
| `HOST` | 0.0.0.0 | HTTP bind host |
| `CLONE_TTL_SEC` | 1800 | Idle TTL before workspace GC |
| `CLONE_MAX_SIZE_MB` | 500 | Reject clones over this size (sniffed via `gh api`) |
| `TMPFS_QUOTA_MB` | 2048 | Match the compose tmpfs size; refuse new clones over budget |

## Production deployment (behind a reverse proxy)

The `docker-compose.yaml` is configured for file-based Traefik routing: the container only joins your Traefik network; the actual router/service/middleware live in your Traefik dynamic config. Trust model: the reverse proxy handles authentication; the app itself serves any request that reaches it.

Generate an htpasswd-format hash for basic-auth:

```bash
htpasswd -nbB <user> <password>
# or, no apache utils handy:
openssl passwd -apr1 <password>
```

Then wire your router + service + a `basicAuth` middleware in your Traefik dynamic config (or equivalent for nginx / Caddy / Cloudflare Access).

## Architecture notes

- **Stateless MCP**: `sessionIdGenerator: undefined`. Each `/mcp` POST gets its own `McpServer` + `StreamableHTTPServerTransport` pair, both closed on `res.on('close')`. No shared server (would leak JSON-RPC IDs across concurrent clients).
- **Module-level CloneManager**: workspace map + GC interval live across requests; init heap paid once at boot.
- **tmpfs `/tmp/repos`**: noexec/nosuid/nodev. Workspaces live and die here; container restart = clean slate.
- **No persistent cache**: clone-per-session is intentionally simpler than LRU hand-rolling. GC sweeper is the only state we maintain.
- **`init: true`** in compose → tini PID 1 reaps stray `git`/`rg`/`gh` children on shutdown.

## Status

v0.2.0 — 7 read-only tools live: clone_repo, grep, read_files, directory_tree, jq, yq, gh_api. Deployed on a single Node process behind a reverse proxy with basicauth.
