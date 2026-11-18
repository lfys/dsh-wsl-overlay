# Security and capability boundaries

This document states exactly what `dsh-wsl-overlay` can do, what it refuses to do, and what data goes where. The marketplace's capability scan and human review both read this file — the claims below are meant to be checkable against the source.

## What the plugin executes

- **On the Windows host**: `wsl.exe` processes (distro listing, the resident agent, wrapped terminal spawns, the session-default wrapper). No other binaries are launched.
- **Inside the distro**: one resident Node process running this package's own `agent/agent.mjs`, started as `wsl.exe -d <distro> --exec <nodePath> <agent.mjs under /mnt>` from the mounted drive. The agent's `exec` op runs commands under `bash -c` — this is the point: it is the same power the model's bash tool already has, placed in the distro.

## Privileges and policy

- The plugin reports `sandboxMode: undefined` (the distro VM is the process boundary). It does **not** claim sandbox enforcement it cannot deliver.
- Every filesystem mutation still fences against the session's execution policy:
  - `read-only` → all writes denied (`FS_SANDBOX_DENIED`);
  - `workspace-write` → the workspace root and additional writable roots are mapped into the distro and containment is checked at path-component boundaries; a root that cannot be mapped **denies — it never widens**;
  - `danger-full-access` → unfenced, as the mode declares.
- Approval policies and `tools/pre-execute` policy plugins of the harness apply unchanged, because the takeover happens at the `fs` / `shell` service layer underneath the ordinary tool pipeline.

## Refusal list (hard red lines)

- No filesystem root deletion: `deleteFile` refuses `/` and empty POSIX paths outright.
- `/mnt` is refused as a workspace root everywhere (route, tool, and client panel) — Windows cannot resolve below `/mnt`, so such a workspace would be unusable; the guard fires before any I/O.
- No `fs.watch` / file-change notifications across the boundary (not supported by WSL; `skill-filesystem`'s watcher is disabled in variants).
- No credential access: the plugin never reads, stores, or forwards harness credentials. Environment forwarded into the distro is limited to the model-friendly terminal set (`NO_COLOR`, `TERM`, `PAGER`, `GIT_PAGER`), the caller's explicit `env`, and the harness's managed `DSH_*` snapshot, via `WSLENV`.
- No clipboard, notification, host-application-launch, or Windows-registry interop.
- No telemetry, no analytics, no outbound connections of its own.

## Network surface

- One HTTP route namespace, `/dsh-wsl-overlay/api`, registered on the harness's existing web server: `status`, `listDistros`, `createWorkspace`.
- Loopback remote addresses only, JSON content-type checks on writes, 64 KiB body cap. A web page cannot reach it from another origin silently.
- The resident agent channel is **stdio only** — it binds no port and listens on nothing.

## Data flows

- Local: Windows ↔ distro over `wsl.exe` stdio and the loopback API. Nothing is written outside the distro's own filesystem and the harness's own workspace registry (a UNC path record the host already persists).
- Remote: nothing. The only network traffic this plugin causes is what the harness itself already sends to its configured model provider.

## Install-time behavior

- `npm install` / `pnpm add` runs **no scripts**: the package declares no `postinstall`, no build hooks. `scripts/dev-links.mjs` is a developer-only convenience, is not published (not in the `files` whitelist), and only creates junctions when invoked manually.

## Known limits stated plainly

- The bash tool inside a WSL variant executes with the distro user's full rights inside that distro. Confinement inside the distro (per-project fencing beyond the workspace-root checks above) is the harness permission modes' job, unchanged by this plugin.
- A session whose sandbox mode is `danger-full-access` has, by definition, no file fence — in Windows mode and in WSL mode alike.
