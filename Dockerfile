# gh-mcp: tumf/mcp-shell-server pinned to 1.0.3, scoped to `gh` + friends.
# Patch: strip `-i` from shell spawn so bash doesn't print job-control warnings
# over stdio (mcp-shell-server runs on a pipe, not a TTY).
FROM python:3.12

ARG MCP_SHELL_SERVER_VERSION=1.0.3

# gh CLI (official apt repo) + keep git for completeness.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg git; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "mcp-shell-server==${MCP_SHELL_SERVER_VERSION}"

# Strip `-i` from the interactive bash spawn. Two call sites in shell_executor.py.
# Without a TTY, `bash -i` prints:
#   bash: cannot set terminal process group ...
#   bash: no job control in this shell
# We don't need job control for one-shot `gh` calls anyway.
RUN python - <<'PY'
import pathlib, re
p = pathlib.Path("/usr/local/lib/python3.12/site-packages/mcp_shell_server/shell_executor.py")
src = p.read_text()
patched = src.replace('{shell} -i -c', '{shell} -c')
assert patched != src, "sed target not found -- upstream changed spawn line"
p.write_text(patched)
print("patched:", src.count('{shell} -i -c'), "sites")
PY

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
