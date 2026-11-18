# dsh-wsl-overlay

[English](README.md) | [简体中文](README.zh.md)

**Transparent WSL takeover for DeepSeek Harness (DSH).** Open a session on a workspace that lives inside a WSL distribution, and the agent's bash, file read/write/edit and search tools run inside the distro — under the same tool names the model already uses. No new tools to learn, no per-command `wsl.exe` wrappers, no path juggling in prompts.

One `wsl-<mode>` variant is published for every agent preset the profile declares (e.g. `wsl-standard`). Sessions on `\\wsl.localhost\...` workspaces compose a WSL variant automatically; an explicit preset pick in the seat always wins. Windows workspaces are untouched — verified byte-for-byte against the stock behavior.

## How it works

- **Preset variants.** For each profile preset the plugin registers a `wsl-<id>` variant whose world group isolates `shell` and `fs`: inside such a session, `ctx.shell` and `ctx.fs` resolve to this plugin's WSL backends, so the native Bash / file tools land in the distro. The distro is never pinned — requests name it through their path, so one variant serves every installed distribution.
- **Resident in-distro agent.** A zero-dependency `agent.mjs` runs inside the distro, speaking JSON lines over `wsl.exe --exec`. Writes are atomic (temp + rename) with mode preservation and a version CAS; edits keep CRLF bytes intact while diffing on LF; exec runs under `bash -c` in a detached process group with timeout kill-tree. One channel per distro, idle-closed after 10 minutes, transparently reopened.
- **Terminal + session defaults.** The host's terminal spawn is wrapped so a WSL-workspace sidebar terminal is a real Linux pty (`--cd` places it in the session directory); new sessions on WSL workspaces default to the WSL variant.
- **Zero private state.** Workspaces are registered as `\\wsl.localhost` UNC paths directly in the harness's own workspace registry — no second store to drift.

## Requirements

- Windows with WSL2 and at least one distribution
- **Node inside the distro**, reachable as `node` without a login shell (the agent starts via `wsl.exe --exec node`; nvm users must set the `nodePath` config to an absolute path):

  ```powershell
  wsl -d Ubuntu-24.04 -u root -- apt install nodejs ripgrep
  ```

- ripgrep inside the distro for the `grep` / `glob` tools (same command above installs it)

## Usage

1. Keep the project inside the distro's Linux filesystem (`/home/...`) — `/mnt` cannot be a workspace root (Windows cannot resolve below it), and the directory must already exist:

   ```powershell
   wsl -d Ubuntu-24.04 -- mkdir -p /home/you/project
   ```

2. Register it as a workspace: click **WSL Workspaces** in the left sidebar (distro dropdown + Linux path + Register), or ask the agent to do it (it uses the plugin's `WSLWorkspace` tool), or POST to the loopback API:

   ```
   POST /dsh-wsl-overlay/api/createWorkspace  {"path": "/home/you/project", "distro": "Ubuntu-24.04"}
   ```

3. Switch the workspace picker to it and start a session — the banner shows *"The same agent, with its shell and file tools running inside WSL."* The sidebar panel also shows live status: distros, published variants, active agent channels.

The workspace appears in the harness's own workspace list immediately. Windows drives are reachable inside sessions as `/mnt/<drive>`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `defaultPreset` | `wsl-standard` | Preset auto-composed for new sessions on WSL workspaces; empty string disables the auto-default |
| `nodePath` | `node` | Node executable used to start the in-distro agent; give an absolute path for nvm setups |
| `bootTimeoutMs` | `60000` | Wait limit for WSL cold start + first agent ping |
| `idleTtlMs` | `600000` | Agent channel idle lifetime; the next request reopens transparently |

## Coexistence with explicit-tool WSL plugins

Plugins that add explicit `wsl*` tools (run-a-Linux-command buttons) work alongside this one without conflicts: different tool names, different mechanism. In a WSL-variant session the transparent backends are primary; an explicit `wsl` tool remains usable, with the caveat that such tools execute below the harness's file policy (their own documented limitation).

## Security boundaries

See [docs/SECURITY.md](docs/SECURITY.md). Short version: the distro VM is the boundary; every mutation still fences against the session's policy (read-only denies; workspace-write requires containment under the workspace root mapped into the same distro; unmappable roots deny). The API is loopback-only. Nothing is installed inside the distro except the agent script being read from the mounted drive; nothing leaves the machine except what the harness itself sends to its configured model provider.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `node is not reachable as "node" inside the distro` | No node in the distro, or nvm is not on a non-login PATH: `apt install nodejs`, or set `nodePath` to an absolute path |
| Workspace registration fails with ENOENT | The directory does not exist yet: `mkdir -p` it in the distro first |
| `/mnt` path refused as a workspace root | By design — move the project under `/home` |
| `uname` in a session returns `MINGW64` (still Windows) | The session is not on a WSL variant: check the workspace path is `\\wsl.localhost\...` and the preset seat shows a `wsl-*` preset; an explicit standard pick wins by design |
| Edit fails with `FS_STALE_VERSION` | The file changed since it was read — re-read and retry; this is the freshness guard working |
| Source edits do not take effect | `link:` installs (web) need a profile restart; `file:` installs (desktop) are snapshots — remove + re-add |

## Development

```powershell
node test/l1-channel.mjs   # channel protocol against the real distro
node test/l2-fs.mjs        # filesystem backend semantics
node test/l2-shell.mjs     # shell executor semantics
node scripts/dev-links.mjs # link peer packages from the local dsh CLI for local runs (dev only)
```

The tests run against the real WSL distro and are safe: all work happens under `/tmp/dsh-wsl-overlay-*`.

## License

MIT
