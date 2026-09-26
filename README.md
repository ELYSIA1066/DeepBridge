# DeepBridge

A local MCP/A2A bridge that enables Codex to delegate tasks to DeepSeek Harness with reusable conversation context.

[![Test](https://github.com/ELYSIA1066/DeepBridge/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/ELYSIA1066/DeepBridge/actions/workflows/test.yml)
[![License](https://img.shields.io/github/license/ELYSIA1066/DeepBridge)](LICENSE)

## Overview

Codex can delegate a focused engineering or technical task to DeepSeek Harness and receive the task status and final response through an MCP tool. The Bridge translates between MCP, A2A, and ACP while leaving the Harness itself unchanged. A local read-only dashboard shows tasks handled by the running Bridge.

## Architecture

```text
Codex Host
    ↓ MCP (stdio)
A2A Bridge
    ↓ ACP
DeepSeek Harness
```

`context_id` and `task_id` have different roles:

- `context_id` identifies a conversation context. Reusing it continues the same in-memory DeepSeek Harness ACP session. Different context IDs remain isolated.
- `task_id` identifies one A2A task. Each delegation gets its own task ID, even when several tasks use the same context.

Context sessions and task records belong to one Bridge process. They are not restored after a Bridge restart.

## Features

- MCP task delegation to DeepSeek Harness through A2A and ACP.
- Multi-turn continuation using a reusable `context_id`.
- Separate context sessions for different contexts.
- Read-only local dashboard with task input, status, progress timeline, and result.
- Bounded startup, session, prompt, cancellation, and cleanup timeouts.
- A2A cancellation forwarding and Bridge permission-request handling.
- Configurable retention limits for terminal A2A tasks.

## Requirements

- Node.js 22.12 or newer.
- Codex with support for local stdio MCP servers.
- DeepSeek Harness installed and configured, with the `acp` profile available.

The Bridge has been tested with `@deepseek-ai/dsh@0.1.5-rc.3`. This is a prerelease; compatibility depends on the external DeepSeek Harness release and is not guaranteed across versions.

Install DeepSeek Harness separately and configure its provider/model before using the Bridge. The Harness CLI can be installed with:

```sh
npm install --global @deepseek-ai/dsh@0.1.5-rc.3
```

## Installation

```sh
git clone https://github.com/ELYSIA1066/DeepBridge.git
cd DeepBridge
npm install
```

Configure a DeepSeek provider/model in DeepSeek Harness. If needed, start its setup UI with `dsh web`, finish configuration, and stop that process. The Bridge starts the ACP profile itself when it needs to run a task.

## Configuration

The Bridge reads configuration from its environment. Invalid or missing timeout values use the documented defaults; `A2A_PORT` and `CONTEXT_IDLE_TTL_MS` must be positive valid integers.

| Variable | Default | Description |
|---|---:|---|
| `A2A_HOST` | `127.0.0.1` | A2A server listen address. |
| `A2A_PORT` | `41241` | A2A server port. |
| `A2A_BRIDGE_URL` | `http://127.0.0.1:41241` | Bridge URL used by the MCP façade. |
| `DSH_COMMAND` | `dsh` | DSH executable name or path; Bridge passes the fixed arguments `--profile acp`. |
| `DSH_HOME` | DSH default | Optional Harness home directory, inherited by Bridge and DSH child processes. |
| `CONTEXT_IDLE_TTL_MS` | `1800000` (30 minutes) | Idle lifetime for a persistent context session; cleanup is checked when a later task arrives. |
| `A2A_TASK_RETENTION_MS` | `86400000` (24 hours) | Retention period for terminal tasks. |
| `A2A_MAX_RETAINED_TASKS` | `500` | Maximum number of retained terminal tasks. |
| `A2A_RETENTION_CLEANUP_INTERVAL_MS` | `60000` (60 seconds) | Periodic terminal-task cleanup interval. |
| `DSH_START_TIMEOUT_MS` | `15000` | Startup, ACP transport, and initialize timeout. |
| `DSH_SESSION_TIMEOUT_MS` | `15000` | ACP session creation timeout. |
| `DSH_PROMPT_TIMEOUT_MS` | `120000` | Timeout for one prompt. |
| `DSH_CANCEL_TIMEOUT_MS` | `5000` | Maximum wait for cancellation and prompt settlement. |
| `DSH_CLOSE_TIMEOUT_MS` | `5000` | ACP session close timeout. |
| `DSH_TERMINATE_GRACE_MS` | `3000` | Grace period for each child-process termination stage. |

The task count and retention limits apply to terminal tasks. A task that remains active is not removed by that retention policy.

## Codex MCP Setup

Register the MCP server with Codex. Replace `<project-root>` with the absolute path to the cloned repository; the command uses the locally installed `tsx` development dependency:

```sh
codex mcp add deepseek-agent --env A2A_BRIDGE_URL=http://127.0.0.1:41241 -- node "<project-root>/node_modules/tsx/dist/cli.mjs" "<project-root>/app/mcp.ts"
```

The MCP façade starts a missing Bridge only when `A2A_BRIDGE_URL` points to a local loopback address. It reuses a healthy existing Bridge. Set `DSH_COMMAND` or `DSH_HOME` in the MCP environment when your DSH installation needs them; the Bridge process receives the MCP environment.

## Usage

Use the `delegate_to_deepseek` MCP tool with a required task description and an optional `context_id`:

```json
{
  "task": "Review the error handling in the current project.",
  "context_id": "project-review"
}
```

Reuse the returned `context_id` to continue that DeepSeek Harness conversation. Omit it to let the MCP façade create a new context. Only one task may be active for a context at a time. Results include the task status and, when available, `task_id` and a direct dashboard link.

## Dashboard

The read-only dashboard is available at `http://127.0.0.1:41241/ui/` while the Bridge is running. It lists tasks handled by that Bridge, groups them by A2A context, and displays task input, status, progress events, and the final result. It refreshes every three seconds while visible. Older retained tasks can be loaded on demand.

The dashboard shows ACP assistant text and tool titles/statuses reported for each task. It does not show model thoughts, tool arguments, or tool results. Progress consists of committed semantic updates, not token-by-token output. Task records and progress are in memory and are lost when the Bridge restarts or retention removes a terminal task.

## Permission Model

The Bridge launches DSH with `DSH_PERMISSION_MODE=read-only` and rejects ACP permission requests according to its Bridge policy. An ACP permission request rejected by the Bridge maps to A2A `REJECTED`.

A tool-level operation that DSH denies under its own policy may instead be described by the assistant as a normal response; if the ACP prompt completes normally, the A2A task can be `COMPLETED`. `COMPLETED` means the prompt completed, not that every requested side effect occurred.

## Security

- The Bridge listens on `127.0.0.1` by default and has no authentication. Do not expose the A2A server or dashboard to a LAN or the public internet without adding an authentication and access-control layer.
- The DSH child process inherits the Bridge process environment. Do not run the Bridge with unrelated secrets in its environment that you do not want Harness tools to access.
- DSH's read-only permission mode is not an operating-system sandbox or a security boundary. Use a least-privilege, appropriately isolated environment, especially for untrusted tasks.
- See [SECURITY.md](SECURITY.md) for reporting and handling security concerns.

## Known Limitations

- Task records, progress, and context mappings are in-memory only. Restarting the Bridge clears them; session recovery and persistence are not implemented.
- There is no global scheduler, queue, or global concurrency limit. Only one active task per context is allowed.
- Idle context cleanup is checked when a later task arrives, rather than by a dedicated timer.
- DSH compatibility depends on the separately installed upstream Harness version and ACP profile.
- Read-only permission mode is not an operating-system sandbox.
- Text input and Markdown text output are supported; progress is available in the local dashboard, while A2A returns task lifecycle updates and the final artifact.

## Testing

```sh
npm test
npm run typecheck
```

The automated tests use mock ACP/DSH boundaries. They do not call DeepSeek or consume API usage.

## License

MIT License. See [LICENSE](LICENSE).
