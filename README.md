# gh-mcp-docker

A containerised `gh` CLI, exposed over the Model Context Protocol (MCP) by
[tumf/mcp-shell-server](https://github.com/tumf/mcp-shell-server). One central
endpoint that every agent session on every host can call, instead of each
host carrying its own `gh` install and its own token.

## Why this exists

### 1. One `gh` endpoint for a heterogeneous fleet

I run agent sessions across several machines: a Mac, a Linux thinkpad, a
personal cloud box, a Raspberry Pi, short-lived cloud sandboxes. Only the Mac
ever had `gh` installed. The rest have `git` + SSH but no `gh`, which meant
the routing rule I kept bumping into was:

> Quick GitHub lookup? Only works if I'm on Mac.

Instead of installing `gh` + syncing a token to every new host, this image
sits behind a single [mcpproxy](https://github.com/smart-mcp-proxy/mcpproxy-go)
upstream named `github-gh-cli`. Any agent session on any host — Mac, Linux,
cloud, remote — hits the same endpoint:

```
github-gh-cli:shell_execute({command: ["gh", "issue", "list", ...], directory: "/tmp"})
```

One token. One `gh` version. One allow-list of commands. Works everywhere.

### 2. Clean stdio output

Upstream `mcp-shell-server` spawns commands with `{shell} -i -c …`, where
`{shell}` is root's login shell (`/bin/bash`). The `-i` flag puts bash into
interactive mode; over a non-TTY stdio pipe, that causes bash to emit on
**every** tool call:

```
bash: cannot set terminal process group (14): Inappropriate ioctl for device
bash: no job control in this shell
```

…appended to the JSON result. Harmless but noisy, and it bloats token usage
for every call. The Dockerfile sed-patches `shell_executor.py` to drop the
`-i`. We don't need job control for one-shot `gh` calls.

## Topology

```
  agent session (any host)
          │
          ▼
    mcpproxy-go  ──upstream──▶  docker exec -i gh-mcp mcp-shell-server
                                        │
                                        ▼
                                      gh CLI (pinned, tokened)
```

mcpproxy's `github-gh-cli` upstream is configured as:

```json
{
  "name": "github-gh-cli",
  "protocol": "stdio",
  "command": "docker",
  "args": ["exec", "-i", "gh-mcp", "mcp-shell-server"]
}
```

The container stays alive with `tail -f /dev/null`; the proxy spawns
`mcp-shell-server` per session via `docker exec`.

## Usage

```sh
cp .env.example .env
# edit .env: set GH_TOKEN / GITHUB_TOKEN to a PAT with the scopes you need
# (repo, read:org are usually enough for read-heavy use)

docker compose build
docker compose up -d
```

Smoke test without the proxy:

```sh
docker exec gh-mcp gh --version
```

The important invariant: `container_name` stays `gh-mcp`, so existing mcpproxy
configs keep working.

## What's allowed

`mcp-shell-server` enforces an allow-list via `ALLOW_COMMANDS`. Default here:

```
gh,git,ls,cat,echo,pwd,which,head,tail,wc,grep,find
```

Everything else is rejected before it hits a shell. Adjust in `compose.yml`
if you need more.

## Credits

- [tumf/mcp-shell-server](https://github.com/tumf/mcp-shell-server) — the MCP
  server doing the heavy lifting.
- [smart-mcp-proxy/mcpproxy-go](https://github.com/smart-mcp-proxy/mcpproxy-go)
  — the proxy that fronts this and 20+ other upstreams.

## License

MIT. Same as upstream.
