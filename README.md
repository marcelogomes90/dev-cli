# dev-cli

`dev-cli` is a local workspace orchestration tool for multi-service projects.

It starts services through a detached supervisor process, keeps live state on disk, exposes a terminal UI for manual control, and lets you inspect logs and basic git status from a single place.

## What It Does

- Starts a full local environment from a declarative `.devrc.yml`.
- Expands service dependencies during the initial startup plan.
- Keeps a long-lived supervisor process per project so commands share the same runtime state.
- Opens a terminal UI to start, stop, restart, install, inspect, and manage services individually.
- Stores per-service logs and opens them in the native terminal viewer from the UI.

## Requirements

- Node.js `>= 20`
- A Unix-like environment is recommended
  Current process management relies on `ps` and POSIX signals.
- `git` is only required for the branch-related UI actions (`pull` and `checkout`).

## How It Works

When you run `dev up <project>` or `dev ui <project>`, the CLI ensures a local supervisor process is running for that project. Commands such as `status`, `ui`, `up`, and `down` talk to that supervisor over a local socket and read the persisted state file when needed.

This keeps the UI responsive and allows service control commands to operate on the same source of truth.

## Configuration

Create a `.devrc.yml` or `.devrc.yaml` in the workspace root:

```yaml
project: amigo-workspace
session: amigo-workspace

hooks:
  beforeUp: echo "Preparing workspace"
  afterUp:
    - echo "Workspace requested"
  beforeDown: echo "Stopping workspace"

groups:
  infra:
    services: [redis]
  api:
    services: [api]

services:
  redis:
    cwd: .
    command: docker run --rm -p 6379:6379 redis
    group: infra

  api:
    cwd: ./api
    command: nvm use && yarn start:dev
    installCommand: yarn
    group: api
    dependsOn: [redis]
    env:
      NODE_ENV: development
```

### Config Reference

#### Root fields

- `project`: project identifier used by CLI commands.
- `session`: optional session name. If omitted, the project name is used.
- `hooks.beforeUp`: command or list of commands executed before `up`.
- `hooks.afterUp`: command or list of commands executed after `up`.
- `hooks.beforeDown`: command or list of commands executed before `down`.
- `groups`: named collections of services. These names can be used with `--only`.

#### Service fields

- `cwd`: working directory for the service command.
- `command`: command used to run the service.
- `installCommand`: optional command used by the UI install action.
- `group`: group name the service belongs to.
- `autostart`: optional boolean, defaults to `true`.
- `env`: optional environment variables merged into the child process.
- `dependsOn`: optional list of service names required for the initial `up` plan.

### Notes

- `dependsOn` is only used during `dev up`.
- `dev up` starts services in dependency phases.
- After one dependency phase is started, the next dependent phase waits 5 seconds before starting.
- Services in the same dependency phase start together after that shared delay.
- `--only` accepts group names or service names.
- Group `layout` metadata is parsed if present in the config, but the built-in UI does not currently depend on it.

## Commands

### `dev up <project>`

Starts the selected project environment through the supervisor and opens the terminal UI by default.

Examples:

```bash
dev up amigo-workspace
dev up amigo-workspace --only infra,api
dev up amigo-workspace --no-ui
```

Options:

- `--only <targets>`: comma-separated groups or service names.
- `--no-ui`: start the environment without opening the TUI.

Behavior:

- If no `--only` value is provided, all services with `autostart: true` are targeted.
- Dependencies are expanded for the initial startup plan.
- A fixed 5-second buffer is applied between dependency phases during `dev up`.
- `beforeUp` and `afterUp` hooks run around the `up` flow.

### `dev ui <project>`

Ensures the supervisor is running and opens the terminal UI without starting services automatically.

```bash
dev ui amigo-workspace
```

### `dev status <project>`

Prints the current service table.

```bash
dev status amigo-workspace
```

Behavior:

- If the supervisor is running, status is read from live supervisor state.
- If the supervisor is not running, a config-based table is printed with services marked as stopped.

### `dev down <project>`

Stops all services managed by the supervisor and shuts the supervisor down.

```bash
dev down amigo-workspace
```

Behavior:

- Runs the `beforeDown` hook before shutdown.
- Stops every managed service and removes the active supervisor state.

## Terminal UI

The built-in UI lets you manage services individually after the supervisor is running.

### Navigation

- `↑/↓` or `j/k`: move between services
- `PageUp` / `PageDown`: scroll logs
- `Home` / `End`: jump to top or bottom of the visible log pane
- `q` or `Esc`: exit the UI

### Actions

- `a` or `Enter`: start the selected stopped service
- `i`: run `installCommand` for the selected stopped service
- `s`: stop the selected running service
- `r`: restart the selected running service
- `c`: clear logs for the selected service when logs exist
- `v`: open the full service log in the native terminal viewer

### Git actions

- `p`: run `git pull --rebase` for a stopped git service
- `d`: prompt for a branch name and run `git checkout`

## Typical Workflow

```bash
dev up amigo-workspace
dev status amigo-workspace
dev ui amigo-workspace
dev down amigo-workspace
```

Common flow:

1. Define the workspace in `.devrc.yml`.
2. Run `dev up <project>` to start the environment.
3. Use the UI to inspect logs and control individual services.
4. Use `dev status <project>` when you want a quick non-interactive snapshot.
5. Run `dev down <project>` to stop everything cleanly.

## Project Scope

This project is focused on local development workflows, not production orchestration. It is designed for projects where a lightweight local supervisor and a terminal-first UI are enough to manage a multi-service workspace.
