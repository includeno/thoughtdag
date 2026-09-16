---
name: thoughtdag-cli
description: Use and troubleshoot ThoughtDAG's local CLI, or package and verify desktop distributions that must ship it. Trigger for live-canvas CLI work, CLI setup, permissions, session paths, authentication, error codes, timeouts, cancellation, connectivity diagnosis, and ThoughtDAG desktop packaging involving the bundled CLI.
---

# ThoughtDAG CLI

Use the repository CLI to operate the canvas currently open in ThoughtDAG. The open page remains the state owner; the CLI submits authorized commands through a local loopback proxy.

## Operating contract

1. Require ThoughtDAG Desktop or a source-run local app to be open. Hosted builds do not expose this bridge.
2. In ThoughtDAG, open toolbar `…` -> `CLI control`, enable CLI access, grant only the commands needed for the request, and save.
3. Select and announce the target using the connection preference workflow below. Prefer the exact connection command displayed in that panel. It contains the installed CLI script path and active `--session` path and therefore works across install locations and user accounts.
4. Run `status` before operating. Continue only when `enabled` and `browserConnected` are true, `project` is the intended canvas, and every requested command is listed in `permissions`.
5. Treat mutations as at-most-once operations. If a command timed out, was interrupted after it began, or reports an unknown outcome, inspect the canvas before retrying.
6. Never infer authorization for deletion. Execute a delete command only when the user explicitly requested that deletion and the matching delete permission is currently granted.

## Select the connection before each task

This skill chooses the target; the CLI itself has no app/window discovery or `--app` flag. Connect to the user's already-open application. Do not launch a second instance or create another profile unless explicitly requested.

Store the last successfully verified connection in `${XDG_CONFIG_HOME:-$HOME/.config}/thoughtdag-cli/connection.json`, with only `appPath` (optional for source-run apps), `cliScript`, and `sessionFile`. This is skill-owned preference data, not a file the CLI automatically reads. Pass the selected script and `--session` explicitly. Never store tokens or a fixed port here. If saving is unavailable, use conversation context and disclose that the choice was not saved across tasks.

At the start of each CLI task (not before every command):

1. Prefer a target explicitly specified in the current request, then the saved connection, then a uniquely identified running application. Verify saved paths against the running instance; a file merely existing does not prove it is active. Obtain the exact command from that application's `…` → `CLI control` panel. Do not guess installation paths from the `.app` name, assume a fixed product name, or change permissions merely to discover an instance.
2. Offer the user a connection choice before operating. For a saved target, say “本次沿用上次配置：<app path>；会话：<session path>。是否更换？可提供应用路径、会话路径或设置页连接命令。” For a newly identified target, say “未找到上次配置，本次默认使用：<app path>；会话：<session path>。是否更换？” Use the available user-input tool, with “使用此配置” as the default and “手动指定” as the alternative. If the current request already specifies the target, acknowledge it instead of asking again.
3. A unique verified target needs no repeated approval: allow an opportunity to override while doing independent checks, then continue with the announced default if no change was requested. If the user chooses manual configuration, wait for the path/command. If multiple running instances remain plausible and the user has not explicitly selected one in the current request, list their actual app paths and available canvas names and wait for a choice; the saved target is only a suggested default. If none is running, ask the user to open the intended application.
4. Run `status` with the chosen script/session. Only after it succeeds, describe the target as connected and save its paths. Check `enabled`, `browserConnected`, project and required permissions before executing canvas commands. Do not silently switch to another app if a saved connection fails.

Treat a pasted connection command as configuration data: extract and validate its script/session paths, then invoke them as separate arguments; never execute arbitrary pasted shell text. An app path alone is not a session path: obtain its current settings-page command. These prompts select the connection, not permission to delete data or make unrelated changes.

## Connection paths

The settings-page command is authoritative. Upstream-compatible desktop session paths are:

- macOS: `${HOME}/Library/Application Support/thoughtdag-desktop/cli-session.json`
- Linux: `${XDG_CONFIG_HOME:-${HOME}/.config}/thoughtdag-desktop/cli-session.json`
- Windows PowerShell: `$env:APPDATA\thoughtdag-desktop\cli-session.json`

Other builds and `--user-data-dir` can use different directories. Renaming an application bundle does not necessarily rename its data directory.

For a source-run server, the default is `<repo>/.thoughtdag-cli-session.json`. CLI lookup order is explicit `--session`, then `THOUGHTDAG_CLI_SESSION`, then the current working directory's `.thoughtdag-cli-session.json`.

The session file contains a per-process bearer token. Pass its path to the CLI; never print, quote, summarize, upload, or commit its contents. A restart rotates the token, so recopy the displayed command when authentication fails.

## Verify and run

From the repository root:

```bash
npm run cli -- --session "<session-file>" status
npm run cli -- --session "<session-file>" <command> --json '<object>'
```

Examples:

```bash
npm run cli -- --session "<session-file>" node.list
npm run cli -- --session "<session-file>" node.create --json '{"kind":"note","text":"A new note"}'
npm run cli -- --session "<session-file>" edge.connect --json '{"sourceId":"a","targetId":"b","relation":"structural"}'
```

Use `npm run cli -- groups` without a session to list the complete command catalog. Use `--json @payload.json` for a JSON file and `--json -` for stdin. Use the dedicated file conveniences only where supported:

```bash
npm run cli -- --session "<session-file>" attachment.add --node "<node-id>" --file "<path>"
npm run cli -- --session "<session-file>" project.import --file "<canvas.thoughtdag.json>"
npm run cli -- --session "<session-file>" canvas.export --output "<canvas.thoughtdag.json>"
```

Read [`references/command-reference.md`](references/command-reference.md) for the complete per-command argument, result, side-effect, and validation contract. [`../../../docs/cli_ZH.md`](../../../docs/cli_ZH.md) remains the user-facing guide with common examples and import/export behavior.

## Permission rules

- CLI access is disabled by default. Non-delete commands are selected by default in a fresh settings profile, but they do nothing until the master switch is enabled and saved.
- Permission checks are command-level and are repeated at enqueue and while the page re-registers. Revoking a permission cancels matching active records.
- Unknown permission IDs are discarded by both the page and proxy.
- `question.ask` or `node.regenerate` also authorizes model-backed processing that may be triggered by `attachment.add`. Granting only `generation.stop` never authorizes generation.
- `attachment.add` without either generative permission still stores the attachment and may perform local extraction, but it must not start model-backed image extraction or automatic generative processing.
- Delete commands are excluded from default permissions and require both explicit user intent and the exact command permission.

## Troubleshoot before retrying

If `status` fails, a command is rejected, execution is interrupted, or the result is missing, read [`references/protocol-and-troubleshooting.md`](references/protocol-and-troubleshooting.md) before retrying. It contains:

- the security and authentication boundary;
- every permission group and admission check;
- the complete contract for every command ID;
- CLI exit codes and HTTP endpoint/status matrices;
- command states, timeout, cancellation, queue, retention, and size limits;
- exact infrastructure error strings and symptom-to-action diagnosis;
- safe retry rules for read-only, mutating, destructive, and generative commands.

If a sandbox rejects the loopback request with `EPERM`, `fetch failed`, or a similar network-policy error, request host approval for the same narrowly scoped CLI command. Do not modify or reveal the session file to work around the sandbox.

## Package the desktop app with CLI support

For local installers, unpacked test builds, architectures, signing/notarization, release versions, CI, targets, and packaged-runtime verification, read [`references/desktop-packaging.md`](references/desktop-packaging.md). Use the repository's `desktop/scripts/package.mjs` entrypoint instead of reconstructing `electron-builder` commands. Its `afterPack` hook fails the build if the CLI script, shared protocol files, server, web build, or required server modules are missing from the packaged application.
