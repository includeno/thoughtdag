# ThoughtDAG CLI protocol and troubleshooting reference

Use this reference when setup, authentication, permission, delivery, execution, cancellation, or result retrieval fails. Error strings shown in backticks are implementation messages and should be searched exactly before guessing at a cause.

## 1. Architecture and security boundary

The CLI bridge has three participants:

1. The standalone Node CLI reads a session file and calls bearer-authenticated proxy endpoints.
2. The local Express proxy authenticates, authorizes, queues, times out, and retains command records.
3. The currently open ThoughtDAG page owns Zustand/IndexedDB state, polls the proxy, acknowledges commands, executes them, and reports results.

Consequences:

- The proxy does not directly edit a canvas. An open, connected page is required even when the proxy process is alive.
- The bridge is for a local loopback proxy. The CLI rejects session URLs unless they use `http:` and hostname `localhost`, `127.0.0.1`, or `::1`.
- The installed desktop app and the normal source server bind to `127.0.0.1` by default. Do not turn this into a network API or copy the bearer token to another machine.
- External CLI routes require an exact `Authorization: Bearer <token>` header.
- Page control routes do not use that bearer token. Registration is limited to an allowed local ThoughtDAG origin; command delivery is tied to an unguessable tab-local `clientId` and the active page registration.
- The proxy accepts JSON request bodies up to 50 MiB. This transport limit is separate from the 40 MiB retained-result limit.

Never print or inspect the token merely to diagnose connectivity. Use the CLI's `status` command and the session path shown by the app.

## 2. Session discovery and lifecycle

The CLI resolves the session file in this order:

1. `--session <path>`
2. `THOUGHTDAG_CLI_SESSION`
3. `<current-working-directory>/.thoughtdag-cli-session.json`

Desktop defaults (other builds or custom profiles may differ):

| Platform | Default session path |
| --- | --- |
| macOS | `${HOME}/Library/Application Support/thoughtdag-desktop/cli-session.json` |
| Linux | `${XDG_CONFIG_HOME:-${HOME}/.config}/thoughtdag-desktop/cli-session.json` |
| Windows PowerShell | `$env:APPDATA\thoughtdag-desktop\cli-session.json` |

The exact command displayed by `CLI control` is authoritative because application names, install layouts, environment overrides, and CLI script locations may differ.

The file schema is version 1 and contains a loopback URL, a random per-process token, process ID, and creation timestamp. The proxy creates it with mode `0600` where supported and removes it during a normal exit if it still owns the token. A crash can leave a stale file. Every server/app restart creates a new token, even when the path and port stay the same.

Session failures:

| Message or symptom | Cause | Action |
| --- | --- | --- |
| `Session file not found: <path>` | Explicit `--session` path does not exist. | Reopen the app, open `CLI control`, and copy the current command/path. |
| `No CLI session file found. Start ThoughtDAG locally, then open Settings → CLI control.` | Neither environment nor current-directory fallback exists. | Start the local app or pass the installed app's explicit session path. |
| `Invalid or unsupported session file: <path>` | Invalid JSON shape, wrong `version`, or missing URL/token. | Do not repair it by hand; restart ThoughtDAG and use the newly written file. |
| `Session URL must use the local loopback proxy: <url>` | The file points to a non-loopback or non-HTTP URL. | Reject it. Use the app-generated session file. |
| `Invalid CLI session token` / HTTP 401 | Stale file, wrong running instance, or token mismatch. | Recopy the current command after restart. Check that the path belongs to the intended app instance. |
| `fetch failed`, `ECONNREFUSED`, or connection refused | No listener at the saved URL, stale process/port, or app still starting. | Confirm the app/proxy is running, then recopy the session path. |
| `EPERM`, `fetch failed`, or network-policy denial only inside an agent sandbox | The host is healthy but the sandbox blocks loopback networking. | Request approval for the same scoped CLI invocation; do not weaken app security. |

## 3. Command and permission catalog

Permissions are exact command IDs. UI groups are presentation conveniences, not wildcard permissions.

| Group | Default | Commands |
| --- | --- | --- |
| `inspect` | Granted | `project.list`, `canvas.get`, `node.list`, `node.get`, `edge.list` |
| `projects` | Granted | `project.create`, `project.switch`, `project.rename` |
| `nodes` | Granted | `node.create`, `node.update`, `node.move`, `node.duplicate`, `node.archive`, `node.classify` |
| `connections` | Granted | `edge.connect`, `edge.update`, `organization.connect` |
| `materials` | Granted | `attachment.add`, `attachment.update`, `highlight.add`, `highlight.mode` |
| `generation` | Granted | `question.ask`, `node.regenerate`, `generation.stop` |
| `organize` | Granted | `canvas.relayout`, `node.align`, `tag.create`, `tag.rename`, `type.create`, `type.rename`, `history.undo`, `history.redo` |
| `transfer` | Granted | `canvas.export`, `project.import` |
| `delete` | **Not granted** | `project.delete`, `node.delete`, `edge.delete`, `organization.delete`, `attachment.delete`, `highlight.delete`, `version.delete`, `tag.delete`, `type.delete` |

“Default granted” means selected in a fresh local settings profile. The master `enabled` switch still defaults to false, and settings must be saved and registered before commands can run.

Permission enforcement details:

- The page filters saved IDs against the shared catalog.
- The proxy independently intersects registered IDs with the shared catalog. Forged/unknown IDs do not become permissions.
- A command must be in the current registered permission set when enqueued.
- If the page later re-registers without that permission, any matching queued, delivered, or running record is cancelled with `Permission was revoked before execution: <command>`.
- Disabling CLI cancels active records with `CLI execution was disabled in ThoughtDAG settings`.
- Permission does not bypass domain validation. Missing node IDs, cycles, malformed arguments, locked canvas state, and similar executor failures still reject the command.
- Possessing a delete permission is not user intent. The agent must still require an explicit deletion request.

### Generative side-effect coupling

`question.ask` and `node.regenerate` are the only permissions that authorize starting model work. If either is granted, `attachment.add` may also perform model-backed image extraction and automatic generative processing. Therefore:

| Permissions | `attachment.add` behavior |
| --- | --- |
| `attachment.add` only | Store the attachment and perform applicable local extraction; no model-backed image extraction or automatic generative cascade. |
| `attachment.add` plus `question.ask` or `node.regenerate` | Model-backed attachment processing may start. |
| `attachment.add` plus `generation.stop` only | Same as `attachment.add` only; stop permission never authorizes starting work. |

When least privilege matters, remove both generative permissions before adding material that must not trigger model work.

## 4. Admission order and externally visible errors

For `POST /api/cli/commands`, checks occur in this order:

1. Bearer token: invalid -> HTTP 401, `Invalid CLI session token`.
2. Known command ID: unknown -> HTTP 400, `Unknown command: <command>`.
3. Master switch: disabled -> HTTP 403, `CLI execution is disabled in ThoughtDAG settings`.
4. Active page heartbeat: missing/stale -> HTTP 409, `No active ThoughtDAG window is connected`.
5. Exact permission: absent -> HTTP 403, `Permission not granted: <command>`.
6. Active-record capacity: 64 already active -> HTTP 429, `CLI command queue is full`.
7. If all pass, the proxy returns HTTP 202 with command ID, bound project ID, and deadline.

This order matters. For example, a disabled CLI reports 403 before a missing permission is considered; a disconnected page reports 409 before permission is considered.

The standalone CLI prints server errors as `ThoughtDAG CLI: <message>` and normally omits the HTTP number because it prefers the JSON `error` field.

## 5. `status` fields

`status` returns:

| Field | Meaning | Healthy expectation |
| --- | --- | --- |
| `enabled` | Last master-switch value successfully registered by the page. | `true` |
| `browserConnected` | A page client is registered and its last heartbeat is less than 35 seconds old. | `true` |
| `project` | Current project metadata reported by the active page, or `null`. | The intended project ID/title. |
| `permissions` | Exact currently registered command IDs. | Contains every command about to be used. |
| `pending` | Count of active `queued`, `delivered`, and `running` records. | Usually 0 before starting. |

Interpretation:

- `enabled: false`: enable and save `CLI control` in the active window.
- `enabled: true`, `browserConnected: false`: the proxy remembers settings, but no page heartbeat is current. Focus/reopen the local page and inspect control settings.
- Wrong `project`: switch intentionally in the UI or use an explicitly authorized project transition; do not run project-bound mutations against a guessed canvas.
- Missing permission: grant only that command and save; then rerun `status`.
- Large `pending`: wait, cancel known work, or diagnose the connected page. Do not enqueue duplicates.

## 6. HTTP endpoint and status matrix

These endpoints are useful when maintaining the bridge. Normal agents should prefer the standalone CLI so the bearer token never appears in shell history.

### Bearer-authenticated external CLI plane

| Method and route | Success | Other expected statuses |
| --- | --- | --- |
| `GET /api/cli/status` | 200 status object | 401 invalid token |
| `POST /api/cli/commands` | 202 accepted | 400 unknown command/malformed JSON; 401 invalid token; 403 disabled or permission missing; 409 no active page; 413 request over 50 MiB; 429 64 active records |
| `GET /api/cli/commands/:id` | 202 while active; 200 terminal | 401 invalid token; 404 missing, expired, or evicted record |
| `POST /api/cli/commands/:id/cancel` | 200 for known record, including already-terminal records | 401 invalid token; 404 missing, expired, or evicted record |

### Same-origin page control plane

| Method and route | Success | Other expected statuses |
| --- | --- | --- |
| `PUT /api/cli/control` | 200 registered settings | 400 `clientId required`/malformed JSON; 403 origin is not the local ThoughtDAG page; 413 oversized body |
| `GET /api/cli/control/next?clientId=...` | 200 command/cancel event; 204 heartbeat/no event/disabled | 409 caller is not the active page |
| `POST /api/cli/control/ack` | 200 acknowledgement outcome | 409 `Unknown CLI command acknowledgement` |
| `POST /api/cli/control/result` | 200 report outcome | 409 `Unknown CLI command result`; 413 payload over proxy body limit |

An HTTP 202 result read is not an error; it means the record is still `queued`, `delivered`, or `running`. Result reads are idempotent while the record is retained.

### Exact bridge/protocol message index

Search these strings verbatim when tracing the responsible layer:

| Message or pattern | Produced by |
| --- | --- |
| `CLI control requires the local ThoughtDAG proxy` | Page refused to register because its backend is not loopback. |
| `CLI control settings must come from the local ThoughtDAG page` | Proxy rejected control registration origin. |
| `clientId required` | Control registration lacks the page ID. |
| `Invalid CLI session token` | Bearer authentication. |
| `Unknown command: <command>` | Proxy catalog admission. The standalone CLI's preflight variant adds `Run "groups" to list commands.` |
| `CLI execution is disabled in ThoughtDAG settings` | Admission, later disable, or active-record cancellation. |
| `No active ThoughtDAG window is connected` | Admission heartbeat check. |
| `Permission not granted: <command>` | Admission permission check. |
| `Permission was revoked before execution: <command>` | Re-registration removed permission from an active record. |
| `CLI command queue is full` | Active-record cap. |
| `Command deadline expired` | Proxy deadline cleanup. |
| `Command cancelled by the CLI client` | Default external cancel reason. |
| `The active project changed while the command was pending or running` | Project re-registration invalidated bound work. |
| `Active project changed before execution (expected <id>, found <id>)` | Page's final project-ID guard. |
| `The active ThoughtDAG window changed` | Server invalidated work/long poll during client replacement. |
| `The active ThoughtDAG window changed before the command ran` | Direct control-plane client replacement before running. |
| `The active ThoughtDAG window changed while the command was running; its outcome is unknown` | Direct control-plane client replacement after ACK. |
| `This is not the active ThoughtDAG window` | Old/foreign page long poll. |
| `Unknown CLI command acknowledgement` | ACK record/client mismatch or missing record. |
| `Unknown CLI command result` | Completion record/client mismatch or missing record. |
| `CLI command not found or expired` | External result/cancel lookup missed or record was evicted. |
| `CLI result is not JSON-serializable` | Successful executor value cannot be retained as JSON. |
| `CLI result exceeds the <bytes>-byte retention limit` | Successful serialized result exceeds the per-result cap. |
| `CLI result exceeds the local proxy response limit` | Page got HTTP 413 while reporting a successful result. |
| `Command failed` | Generic fallback when no more specific executor/result error exists. |

## 7. Command lifecycle

| State | Meaning | Can transition to |
| --- | --- | --- |
| `queued` | Accepted and waiting for the page poller. | `delivered`, `cancelled`, `timed_out`, failure caused by window/settings/project change |
| `delivered` | Sent to the page but not yet acknowledged. | `running`, `cancelled`, `timed_out`, failure caused by window/settings/project change |
| `running` | Page acknowledged before executing. | `completed`, `cancelled`, `timed_out`, failure caused by window/settings/project change |
| `completed` | Terminal success or executor/result failure. Check `ok`. | None |
| `cancelled` | Proxy marked the record cancelled. | None |
| `timed_out` | Proxy deadline cleanup marked it expired. | None |

Ordinary commands execute serially in the page through one promise tail. A long generation or extraction can therefore delay later ordinary commands even though multiple records were accepted. `generation.stop` is the exception: it is scheduled immediately so it can interrupt current generation rather than waiting behind it.

Project binding:

- Each accepted record stores the active project ID from enqueue time.
- Immediately before execution, the page compares that ID with its current active project. A mismatch fails with `Active project changed before execution (expected <id>, found <id>)`.
- Re-registering a different project cancels mismatched active records with `The active project changed while the command was pending or running`.
- A running `project.create`, `project.switch`, `project.import`, or `project.delete` is exempt from that project-change cancellation because changing the active project is its intended effect.

Window binding:

- Only one tab-local page client is active in a proxy process.
- A different page registration invalidates the prior delivery stream. Errors may include `The active ThoughtDAG window changed`, `The active ThoughtDAG window changed before the command ran`, or `The active ThoughtDAG window changed while the command was running; its outcome is unknown` depending on the transition path.
- `This is not the active ThoughtDAG window` and `The active ThoughtDAG window changed` on page polling mean the old page must stop polling and the newly registered page owns subsequent work.

## 8. Cancellation and interruption semantics

Cancellation is cooperative and best-effort:

- Cancelling `queued` work makes it terminal before delivery.
- Cancelling `delivered` or `running` work marks the proxy record terminal immediately and sends a cancel event to the page.
- The page invokes a command-specific cancel handler when one exists. Generation/extraction work can register such a handler. Many synchronous mutations finish too quickly or have no meaningful rollback hook.
- A cancel response field `running: true` means the command had started before it was marked terminal. It does **not** mean it is still executing after the response.
- Late results after cancellation/timeout are rejected because only `running` records accept completion.
- SIGINT asks the proxy to cancel the active record with a 2-second request budget, then exits 130. SIGTERM does the same and exits 143.
- When the CLI's own wait deadline expires, it makes a cancellation request with a 5-second request budget and reports `Command timed out and cancellation was requested after <ms>ms`.

Never assume cancellation rolled back a mutation. If the record was `running`, inspect project/canvas state before deciding whether to retry or compensate.

## 9. Time, concurrency, retention, and size limits

| Limit | Value | Diagnostic implication |
| --- | --- | --- |
| CLI command timeout default | 600,000 ms (10 min) | Used when `--timeout` is omitted. |
| Allowed command timeout | 1,000-3,600,000 ms | CLI rejects outside range; proxy also clamps submitted values into this range. |
| Per HTTP request timeout in CLI | 30,000 ms | A single stalled proxy request can fail before the overall command deadline. |
| Page registration/control request timeout | 30,000 ms | Settings save/ACK/result reporting can time out independently. |
| Page long-poll duration | 20,000 ms | A 204 is a normal heartbeat, not disconnect. |
| Browser heartbeat TTL | 35,000 ms | Longer silence makes `browserConnected` false. |
| Poll retry after non-409 page error | 1,500 ms | Temporary page/proxy errors retry while CLI remains enabled. |
| CLI terminal-result poll interval | 350 ms | Repeated HTTP 202 is expected while active. |
| Result-report retries | Up to 3 | Only non-4xx failures retry, after 250/500/750 ms. |
| Maximum active records | 64 | The 65th enqueue returns 429. Active includes queued, delivered, running. |
| Maximum retained records | 512 | Oldest terminal records are evicted first when over the cap. Active records are not cap-evicted. |
| Terminal retention age | 1 hour | Afterwards result/cancel can return 404. Cleanup happens on control-plane activity. |
| One successful retained result | 40 MiB | Larger JSON-serialized results become terminal failures. |
| Total retained successful-result data | 64 MiB | Oldest terminal records with result data are evicted until under cap. |
| Express JSON body | 50 MiB | Oversized attachment/import/result-report bodies can receive HTTP 413. |

Result-size failures:

- `CLI result is not JSON-serializable`: executor returned a value JSON serialization cannot represent.
- `CLI result exceeds the 41943040-byte retention limit`: serialized successful result is over 40 MiB.
- `CLI result exceeds the local proxy response limit`: the page's successful result report hit HTTP 413; it then attempted to replace it with this smaller failure.
- HTTP 404 shortly after a large amount of output can mean the record was evicted by the 512-record or 64 MiB total-retention cleanup, not that it never existed.

Prefer `--output <path>` for exports, but note that it writes the result only after the result has crossed and survived the proxy retention boundary; it does not bypass the 40 MiB limit.

## 10. Standalone CLI validation and exit codes

The CLI writes fatal messages to stderr as `ThoughtDAG CLI: <message>`.

| Exit code | Meaning |
| --- | --- |
| 0 | Help/groups/status succeeded, or command completed successfully and output was printed/written. |
| 1 | Argument, session, transport, HTTP, timeout, executor, or result failure. |
| 130 | Interrupted by SIGINT/Ctrl-C; active-record cancellation was attempted. |
| 143 | Interrupted by SIGTERM; active-record cancellation was attempted. |

Client-side validation messages include:

- `<option> requires a value`
- `Unexpected arguments: ...`
- `Unknown command: <command>. Run "groups" to list commands.`
- JSON parser errors from invalid inline/file/stdin JSON
- `--json must contain an object`
- `--file is supported by attachment.add and project.import`
- `--timeout must be between 1000 and 3600000ms`
- native file errors for unreadable `--file`, `@payload.json`, `--output`, or session paths

Option notes:

- `--json '<object>'`, `--json @file`, and `--json -` all require a JSON object, not an array or scalar.
- `--file` is only accepted for `attachment.add` and `project.import`.
- `--node` is a convenience consumed by `attachment.add`; other command payloads should use `--json`.
- `--output` serializes string results as-is and all other results as formatted JSON.
- Help and `groups` do not require a session. Every other command, including `status`, does.

## 11. Executor and import validation error catalog

Executor failures are returned as a terminal command with `state: "completed"`, `ok: false`, and the error text. They are not HTTP permission failures. Dynamic placeholders below identify the bad field or live entity.

### General argument and live-entity validation

| Error or pattern | Meaning/action |
| --- | --- |
| `<name> must be a non-empty string` | A required string such as `nodeId`, `edgeId`, `projectId`, `name`, or `question` is missing/blank/not a string. |
| `<name> must be a non-empty array of IDs` / `<name> must be an array of IDs` | Supply the required ID array; empty is permitted only for fields whose command semantics allow clearing. |
| `Node not found: <id>` / `Edge not found: <id>` / `Project not found: <id>` | Refresh live state and use an ID from the intended active project. |
| `Tag not found: <id>` / `Type not found: <id>` | Refresh taxonomy; import, rename, undo, or delete may have invalidated the ID. |
| `Unsupported CLI command: <command>` | Catalog and executor are out of sync; this is a source/build defect, not a permission issue. |

### Nodes, edges, organization, and taxonomy

| Error or pattern | Meaning/action |
| --- | --- |
| `Unsupported node kind: <kind>` | Use `ask`, `note`, `file`, `link`, `frame`, `human`, or `prompt`. |
| `url is required for link nodes` | A `kind: "link"` node needs a non-empty `url`. |
| `relation must be structural, reference, or watch` | Correct the edge relation enum. |
| `An edge cannot connect a node to itself` | Source and target must differ. |
| `Frame nodes cannot be edge sources` | Choose a non-frame source. |
| `Material and frame nodes cannot receive incoming edges` | `note`, `file`, `link`, and `frame` cannot be an edge target. |
| `Material and frame nodes cannot receive an incoming parent edge` | Do not create these node kinds with `parentId`. |
| `Edge already exists: <id>` | Do not retry; inspect or update the existing edge. |
| `Structural edge would create a cycle` | Choose another structural direction or an explicitly intended reference/watch relation. |
| `kind must be parent or jump` | Correct `organization.connect.kind`. |
| `Frame nodes cannot be organization relation endpoints` | Choose non-frame endpoints. |
| `Organization relation rejected (<reason>): <cycle>` | The relation violates duplicate/cycle/knowledge-graph rules; use the returned reason/path. |
| `Organization relation could not be created` | Store rejected the otherwise prepared relation; refresh relations before retry. |
| `One or more organization relations were not found` | One or more delete IDs are stale/wrong. Reconfirm explicit delete targets. |
| `node.classify requires tagIds and/or customTypeId` | Supply at least one classification field. |
| `Tag name already exists: <name>` / `Type name already exists: <name>` | Names are unique after normalization/case comparison; reuse or choose another name. |
| `versionIndex must be a non-negative integer` | Correct `version.delete.versionIndex`. |

### Node patch, edge update, material, and generation validation

| Error or pattern | Meaning/action |
| --- | --- |
| `patch.question must be a string` / `patch.response must be a string` | Correct the `node.update` patch type. |
| `patch.<field> must be a string or null` | Correct optional string/null patch fields. |
| `patch.<field> must be a boolean` | Correct boolean patch fields. |
| `patch.roleMode must be inherit, set-next, or reset` | Correct the role-mode enum. |
| `patch.highlightMode must be off, tag, or filter` | Correct the highlight-mode enum. |
| `patch.autoRerunRounds must be an integer from 1 to 5` | Use an integer in the allowed range. |
| `patch.<field> must be a positive finite number` | Correct positive numeric layout/dimension fields. |
| `depth must be quote or full` | Correct `edge.update.depth`. |
| `depth applies only to reference or watch edges` | Do not set context depth on a structural edge. |
| `followsTip must be a boolean` | Correct `edge.update.followsTip`. |
| `edge.update requires relation, structural, sourceId, targetId, depth, or followsTip` | Supply at least one supported change. |
| `attachment required` | `attachment.add` needs an attachment object; prefer `--file` convenience. |
| `mode must be off, tag, or filter` | Correct `highlight.mode.mode`. |
| `Question was not created` | Generation setup returned without creating its node; inspect generation/store logs before retry. |
| `Generation failed` or model response text | The node reports generation failure; inspect model configuration and returned node response. |
| `Canvas transfer is unavailable while generation or extraction is in progress` | Wait for or stop active work before `canvas.export`/`project.import`. |

### Import schema and graph validation

| Error or pattern | Meaning/action |
| --- | --- |
| `A run manifest is not an importable canvas backup` | Import a canvas backup, not `thoughtdag-manifest`. |
| `nodes and edges arrays required` | Both top-level arrays are mandatory. |
| `sharedReadonly must be a boolean` | Correct the top-level flag type. |
| `Unsupported project schema version: <version>` | Export/import versions are incompatible; use a supported backup. |
| `<name> requires a non-empty id` | Imported node/edge entity lacks an ID. |
| `<name> <id> requires a finite position` / `requires data` | Imported node position/data is invalid. |
| `<name> <id> has invalid tagIds` / `has an invalid customTypeId` | Imported node taxonomy references have the wrong shape. |
| `<name> <id> requires source and target IDs` / `cannot be a self-loop` | Imported edge endpoints are invalid. |
| `<name> <id> is a render-only organization edge` | A render-only edge was placed in the persisted edge list. |
| `Duplicate imported node id: <id>` / `Duplicate imported edge id: <id>` | IDs must be unique. |
| `Imported edge <id> references a missing node` | Both endpoints must exist in imported nodes. |
| `Imported structural edges contain a cycle` | Fix structural DAG direction/cycles. |
| `<name> must be an array` / `<name>[<index>] is invalid` | A taxonomy/relation/import collection has the wrong shape. |
| `Duplicate <name> id: <id>` / `Duplicate <name> name: <name>` | Imported tag/type IDs and normalized names must be unique. |
| `taxonomy must be an object` | Supply a valid taxonomy object. |
| `<name> is invalid` / `<name> cannot be a self-loop` | Organization relation shape/endpoints are invalid. |
| `organizationRelations must be an array` | Correct the collection type. |
| `Organization relation <id> references a missing node` / `references a frame` | Fix relation endpoints. |
| `Duplicate organization relation id: <id>` / `Duplicate organization relation: <id>` | Remove duplicate IDs or endpoint-kind tuples. |
| `Organization parent cycle: <path>` | Fix parent-relation cycle. |
| `instantiatedFrom is invalid` | Correct/remove project provenance metadata. |
| `Node <id> references an unknown tag: <id>` / `references an unknown type: <id>` | Define the taxonomy entry or remove the stale node reference. |

### Imported event and transaction-history validation

These errors originate in transaction replay validation and are propagated unchanged by `project.import`:

- `events must be an array`
- `events[<index>] is invalid`
- `events[<index>].d is invalid`
- `<name> must be an array`
- `<name>[<index>] is invalid`
- `<name>[<index>] has no before or after entity`
- `Duplicate <name> entity id: <id>`
- `<name>[<index>].before id does not match`
- `<name>[<index>].after id does not match`
- `<name>[<index>].<beforeIndex|afterIndex> must be a non-negative integer`
- `<name>[<index>].beforeIndex requires a before entity`
- `<name>[<index>].afterIndex requires an after entity`
- `transactions must be an array`
- `transactions[<index>] is invalid`
- `Duplicate transaction id: <id>`
- `transactions[<index>] has invalid revisions`
- `transactions[<index>].changes.taxonomy is invalid`
- `transactions[<index>] change cannot have targetId`
- `transactions[<index>] references an unknown change transaction`
- `<name> must be an array of transaction IDs`
- `<name> contains duplicate IDs`
- `<name> references an unknown change transaction: <id>`
- `Transaction <id> cannot be both undoable and redoable`
- `revision must exactly match the transaction log`
- `<name> references an unknown tag: <id>`
- `<name> references an unknown type: <id>`
- `<name> contains duplicate id: <id>`
- `<name> contains a structural edge cycle`
- `<name>.edges contains duplicate id: <id>`
- `<name>.edges[<index>] references an invalid endpoint`
- `<name>.edges[<index>] is a render-only organization edge`
- `<name>.organizationRelations[<index>] references an invalid endpoint`
- `<name>.organizationRelations[<index>] is duplicated`
- `<name> contains an organization parent cycle`
- `<name>.changes[<index>].<side> expects entity <id> to be absent`
- `<name>.changes[<index>].<side> is not continuous for entity <id>`
- `<name>.changes[<index>].<side> has an inconsistent entity index`
- `<name>.taxonomy.<side> is not continuous`
- `transaction log does not reproduce the current snapshot`

Do not “fix” an import by stripping transaction fields blindly: readonly exports intentionally omit history, while editable backups rely on history consistency. Re-export from the source when possible.

## 12. Error-to-action matrix

| Error/symptom | Layer | Likely cause | Correct action | Retry safety |
| --- | --- | --- | --- | --- |
| `Invalid CLI session token` | Auth | Token rotated or wrong instance. | Recopy current app command/session. | Safe before acceptance. |
| `CLI execution is disabled in ThoughtDAG settings` | Admission/settings | Master switch off or page re-registered disabled. | Enable, save, rerun `status`. | Safe if enqueue was rejected; inspect if it cancelled running work. |
| `No active ThoughtDAG window is connected` | Admission/heartbeat | No page, stale >35 s, old page, or page poller stopped. | Reopen/focus local canvas, inspect CLI control, rerun `status`. | Safe because enqueue was rejected. |
| `Permission not granted: <command>` | Admission/permission | Exact command absent. | Grant only the required command, save, verify status. | Safe because enqueue was rejected. |
| `Permission was revoked before execution: <command>` | Lifecycle | Settings changed after acceptance. | Decide whether revocation was intentional. Inspect if it had reached running. | Conditional. |
| `CLI command queue is full` | Admission/capacity | 64 active records, often duplicates or stalled page. | Check `pending`; wait or cancel known requests; fix page connection. | Do not enqueue another duplicate. |
| `Command deadline expired` | Lifecycle | Record exceeded server deadline. | Restore connection if needed; inspect state before retry. | Read-only usually safe; mutation conditional. |
| `Command timed out and cancellation was requested after ...` | CLI wait | Client deadline ended; cancellation was requested, not guaranteed rollback. | Inspect canvas/project before retry. | Conditional/unsafe blind retry. |
| `CLI command not found or expired` | Retention | Wrong ID, >1 h old, >512 records, or result-data eviction. | Do not infer failure. Inspect target state and logs; rerun only if safe. | Conditional. |
| `Active project changed before execution ...` | Page execution | Enqueue project differs from current active ID. | Verify intended project, switch explicitly, resubmit once. | No executor mutation should have begun. |
| `The active project changed while the command was pending or running` | Lifecycle | UI/CLI project transition occurred mid-flight. | Inspect both old and new projects before retrying. | Conditional. |
| Window changed / outcome unknown | Lifecycle | Another ThoughtDAG tab registered. | Identify active window and inspect state. Avoid duplicate mutation. | Unsafe blind retry. |
| `Unknown CLI command acknowledgement` | Internal page protocol | Record/client changed, expired, or already invalidated before ACK. | Check active window/project and proxy logs. | External caller should not retry mutation blindly. |
| `Unknown CLI command result` | Internal page protocol | Late/foreign result after cancellation/window change/eviction. | Treat executor outcome as potentially applied; inspect state. | Unsafe blind retry. |
| Repeated HTTP 202 | Result polling | Command active; ordinary work may be waiting behind long work. | Wait within deadline; use authorized `generation.stop` for generation, not duplicate enqueues. | Do not duplicate. |
| HTTP 413 / result limit message | Transport/result | Input >50 MiB or output beyond proxy/retention limits. | Reduce/split input or request a smaller result. | Depends on whether execution already happened. |
| Domain message such as node not found, duplicate/cycle/invalid args | Executor | Payload contradicts live canvas state. | Read current state and correct payload. Do not broaden permissions. | Usually safe after confirmed executor rejection. |
| `Canvas transfer is unavailable while generation or extraction is in progress.` | Executor lock | Export/import overlaps active generation/extraction. | Stop/wait for that work, then retry transfer. | Safe after lock clears because transfer was rejected. |
| Could not report result / later 404 | Page-to-proxy reporting | Proxy restart, client change, network failure, 4xx rejection, or eviction. | Inspect live state; proxy record is not proof of rollback. | Conditional. |

## 13. Diagnostic workflow

Follow this order and stop as soon as the failing layer is identified:

1. Confirm this is a local Desktop/source-run canvas, not a hosted build.
2. Copy the exact command from `CLI control`; do not reconstruct the CLI script path if the app already supplies it.
3. Run `status` without printing the session file.
4. If authentication/connection fails, diagnose session freshness, running process, loopback reachability, and sandbox policy in that order.
5. If status succeeds, compare `enabled`, `browserConnected`, `project.id`, `permissions`, and `pending` with the intended operation.
6. Run a read-only command such as `project.list`, `canvas.get`, or `node.list` when its permission is granted. This distinguishes delivery/execution failure from a command-specific payload failure.
7. Validate payload IDs against fresh read-only state. Do not reuse stale node/edge/project IDs after import, duplicate, delete, undo, redo, or project switch.
8. For accepted commands, distinguish `queued`, `delivered`, and `running`; only the last proves the page acknowledged execution.
9. For timeout, cancel, window/project change, missing result, or result-report failure after `running`, inspect the canvas before retrying.
10. Retry only after correcting the identified layer. Never solve permission or connectivity errors by granting broad delete/generation access or exposing the token.

When maintaining source code, inspect these implementation points:

- catalog/default/generative permissions: `shared/cli-commands.mjs`
- queue, states, limits, cancellation, retention: `shared/cli-control-plane.mjs`
- bearer and HTTP routes/session creation: `server.mjs`
- page registration, serial execution, result reporting: `src/lib/cli-control.ts`
- command domain behavior: `src/lib/cli-executor.ts`
- standalone arguments, polling, exit codes: `scripts/thoughtdag-cli.mjs`
- protocol coverage: `scripts/cli-protocol-test.mjs`, `scripts/cli-http-test.mjs`, `scripts/cli-attachment-permission-test.mjs`

## 14. Safe retry policy

- Read-only inspection commands: retry after fixing auth/connectivity if no excessive load is created.
- Admission rejection before HTTP 202: retry after correcting the stated condition; no command record was created.
- `queued` cancellation confirmed before delivery: retry after correcting the cause.
- `delivered` but not acknowledged: usually no executor work began, but a client/window transition can race; confirm state for mutations.
- `running`, timeout, SIGINT/SIGTERM, page/window/project change, result-report failure, or unknown/expired record: inspect state first.
- Create/connect/update/import/generation commands: use returned IDs or live state to detect whether the effect already exists before retrying.
- Delete commands: never retry automatically. Reconfirm target existence, current project, explicit user intent, and exact permission.
- Generative commands: avoid parallel duplicates. Use `generation.stop` only when authorized and requested/necessary; then verify final node/version state.
