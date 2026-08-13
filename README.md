# gh-cli-mcp-http

Self-hosted MCP server for **live GitHub operations** — explore codebases (grep / read / tree / jq / yq) and act on them (`gh release create`, `gh pr create`, `gh repo create`, anything `gh` can do). PAT scope is the policy: the server faithfully executes whatever subcommand the agent asks for and returns whatever GitHub gave back. No subcommand allowlist, no in-process write blocker.

## Why this exists

DeepWiki and similar tools index codebases periodically — agents always tap into a stale view. This server clones live from GitHub on demand for exploration AND exposes a faithful `gh` execution tool for orchestration (releases, PRs, repo creation, workflow dispatch). The tool surface is intentionally narrow (no shell, no on-workspace edit) but otherwise unrestricted; what the agent can do is governed by the PAT scope you provision, not by in-process gates.

v0.3.0 builds on v0.2.0's HTTP MCP foundation (native `@modelcontextprotocol/sdk` transport, no supergateway, no stdio bridge) and pivots from read-only to **PAT-scoped**: the original `gh_api` GET-only restriction is dropped, and a general `gh` execution tool is added so agents can run any subcommand. The original `gh-mcp-docker` (Python shell-wrapper via supergateway) it replaces is no longer maintained.

## Resource profile

Single Node process, no spawning beyond `git`/`gh`/`rg`/`jq`/`yq` subprocesses scoped to one request. Resting ~40 MiB.

**Cloned bytes are memory, not disk.** `/tmp/repos` is a tmpfs, so its pages are charged to the container's memory cgroup as `shmem`, and unlike page cache they are not reclaimable under pressure. The clone budget must therefore stay *under* the container memory limit, never above it. The shipped numbers:

| Knob | Value | Relationship |
| --- | --- | --- |
| compose `memory` limit | 768 MiB | must be >= tmpfs + heap + page cache headroom |
| compose `tmpfs` size | 512 MiB | hard ceiling; hitting it returns ENOSPC |
| `TMPFS_QUOTA_MB` | 448 | soft ceiling; manager evicts before ENOSPC |
| `CLONE_MAX_SIZE_MB` | 350 | one repo can never swallow the whole budget |

Reclamation runs on three independent paths, so no single failure pins memory:

1. **TTL eviction** — workspaces idle beyond `CLONE_TTL_SEC` (default 30 min) are removed; sweeper runs every 5 min. Every tool call touches `lastAccessed`, so the clock only runs while a workspace is genuinely unused.
2. **Orphan reconcile** — the same sweep deletes any UUID-shaped directory in the mount that no live workspace claims. This is what makes GC self-healing: a directory that falls out of the in-memory map (crash, failed unlink, leftovers from a previous process) would otherwise pin tmpfs pages with nothing left to evict it. Non-UUID paths are never touched.
3. **LRU eviction under pressure** — admission is measured with `statfs` against the real mount, not by summing remembered sizes. A clone that would breach `TMPFS_QUOTA_MB` evicts least-recently-used workspaces to make room rather than failing the caller. Only a repo that cannot fit in an empty tmpfs is rejected.

**Clone dedup**: requesting the same `repo` + `ref` + `depth` within `CLONE_REUSE_WINDOW_SEC` returns the existing `workspace_id` (`reused: true`) instead of cloning a second copy. Every workspace-consuming tool is read-only, so sharing is safe. This matters when several agents research the same repository concurrently — without it, N clients materialise N identical checkouts.

## Quick start

```bash
cp .env.example .env
# edit .env: set GH_TOKEN (fine-grained PAT; scope = capability — see README §Token / PAT)
docker compose up -d --build
curl http://localhost:8000/healthz   # -> ok
```

MCP endpoint: `POST /mcp` (StreamableHTTP, stateless).

Connect from Claude Code:

```bash
claude mcp add --transport http gh-cli https://<user>:<password>@<your-host>/mcp
```

## Tools (8, PAT-scoped)

| name | purpose |
|---|---|
| `clone_repo` | Clone owner/repo into ephemeral workspace, return workspace_id |
| `grep` | ripgrep with auto section-end hints for follow-up reads |
| `read_files` | Multi-file, multi-slice batched read with offset/limit/tail/pattern |
| `directory_tree` | Recursive listing with auto-depth caps + ignore conventions |
| `jq` | JSON query against any workspace file |
| `yq` | YAML/XML/TOML/CSV/INI/HCL query (mikefarah's yq) |
| `gh_api` | `gh api <path>` passthrough, any HTTP method allowed (subject to PAT scope). Optional `jq` filter projects the response before return. |
| `gh` | Faithful `gh <args>` execution — any subcommand (`release create`, `repo create`, `pr create`, `workflow run`, etc.). Authority = PAT scope. |

The `gh` tool is intentionally general — no subcommand allowlist, no flag blocklist. **PAT scope is the entire policy boundary**: if your PAT can do X, the agent can do X. The server is as powerful as the credential you give it; provision accordingly. Sandbox layers (tmpfs, cap-drop, non-root user, container memory cap, no submodule update) protect the host, not GitHub.

No `bash` / `run_command` / on-workspace `edit` tool — `gh` covers orchestration; raw shell would add attack surface without adding capability.

### Default ignore behavior

Both `directory_tree` and `grep` skip the typical noisy dirs (`node_modules`, `.git`, `dist`, `build`, `target`, `.venv`, `__pycache__`, `vendor`, `.next`, `.nuxt`, `.turbo`, `coverage`, `Pods`, `DerivedData`, lockfile caches, editor metadata, etc.) by default — the common case is a clean codebase walk, not a bytecode tour. Opt back in when you need it:

- `directory_tree`: set `include_ignored: true` to walk everything, or pass `extra_skip: ["foo", "bar"]` to append more names. The response echoes a `skipped_dirs` list of names actually encountered, so an agent can discover what it missed and re-call.
- `grep`: set `no_ignore: true` for raw `rg --no-ignore --hidden` semantics (also drops the default exclude glob); or `hidden: true` to include dot-prefixed files while keeping `.gitignore` respect and the default exclude glob. The default behavior also honors the workspace's `.gitignore`.
- Skip set applies on **recursion**, not on the entry path. If you explicitly target `path: node_modules/lodash`, the walk descends from there.

## Config

| env | default | purpose |
|---|---|---|
| `GH_TOKEN` | (required) | Fine-grained PAT (or classic). Scope = capability — server enforces nothing, GitHub enforces everything. See README §Token / PAT below. |
| `PORT` | 8000 | HTTP bind port |
| `HOST` | 0.0.0.0 | HTTP bind host |
| `CLONE_TTL_SEC` | 1800 | Idle TTL before workspace GC |
| `CLONE_MAX_SIZE_MB` | 350 | Reject clones over this size (sniffed via `gh api`) |
| `TMPFS_QUOTA_MB` | 448 | Soft budget, kept below the compose tmpfs size; LRU-evict over budget |
| `CLONE_REUSE_WINDOW_SEC` | 300 | Reuse an existing checkout for an identical repo+ref+depth request; 0 disables |

## Token / PAT

**Scope = capability.** The server enforces nothing about which `gh` subcommands or REST methods are "allowed" — it faithfully runs whatever the agent asks. GitHub enforces the PAT's scope set. Provision the smallest scope that fits your use case:

| Use case | Fine-grained PAT scopes |
|---|---|
| Read-only exploration | `Contents: Read` + `Metadata: Read` |
| Above + publish releases | `+ Contents: Write` |
| Above + create repos | `+ Administration: Write` |
| Above + dispatch workflows / manage secrets | `+ Actions: Write` + classic `workflow` scope |
| Above + author PRs / issues | `+ Pull requests: Write` + `Issues: Write` |
| Full agent autonomy | all of the above |

Classic PATs work too (`repo`, `workflow`, etc.) and are required for cross-org private repos where you're not a direct member.

**Trust model implication:** the resulting token is as powerful as its scope set. A leak of the reverse-proxy basic-auth credential gives any reachable client this exact capability. Pick the basic-auth strength accordingly, and rotate the PAT (30–90 days) when scopes change — do not retroactively expand an existing one (audit trail).

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
- **No persistent cache**: clones stay ephemeral. The manager keeps only a short reuse window plus LRU eviction under budget pressure — enough to stop duplicate concurrent clones without becoming a cache with invalidation semantics to get wrong.
- **Ops endpoints**: `GET /workspaces` reports live workspaces plus `tmpfs_used_mb` / `tracked_mb`. A persistent gap between those two means the reconcile sweep is losing. `POST /gc` forces an immediate sweep without waiting 5 minutes or restarting.
- **`init: true`** in compose → tini PID 1 reaps stray `git`/`rg`/`gh` children on shutdown.

## Status

v0.3.0 — 8 tools live (PAT-scoped, no longer read-only): clone_repo, grep, read_files, directory_tree, jq, yq, gh_api (now multi-method + optional jq filter), gh (general execution). Deployed on a single Node process behind a reverse proxy with basicauth.
