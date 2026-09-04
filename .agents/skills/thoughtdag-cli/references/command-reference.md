# ThoughtDAG CLI complete command reference

All command payloads are JSON objects. Unknown extra properties are generally ignored unless an imported nested structure is validated as a whole. IDs are live canvas IDs, not labels. Read current state before mutations instead of guessing IDs.

The result shown here is the command's `result` value after terminal success. The standalone CLI prints it as formatted JSON unless it is a string or `--output` is used.

## Inspection

### `project.list`

- Args: none.
- Result: `{ activeId, projects }` using the project store's metadata array.
- Notes: read-only.

### `canvas.get`

- Args: optional `sharedReadonly: boolean`, default false.
- Result: the same v2 transfer object as `canvas.export`.
- Notes: flushes pending canvas transactions; fails while generation/extraction prevents a consistent transfer snapshot.

### `node.list`

- Args: none.
- Result: compact nodes with `{ id, kind, question, response, position, archived, attachments }`. Each attachment is reduced to `{ id, name, type, size }`.
- Notes: read-only; use this to resolve IDs without returning the full canvas.

### `node.get`

- Args: required `nodeId`.
- Result: full live node object.
- Notes: fails when the node is absent.

### `edge.list`

- Args: none.
- Result: full context-edge array. Organization relations are separate and appear in `canvas.get`.
- Notes: read-only.

## Projects

### `project.create`

- Args: optional `name`, default `Untitled`; optional `kind`, where only `paradigm` selects paradigm and every other/missing value selects chat.
- Result: `{ id, activeId }`.
- Side effect: creates and activates a project. It is a project-transition command and may legitimately change the active project while running.

### `project.switch`

- Args: required `projectId`.
- Result: `{ activeId }` after switching.
- Side effect: activates an existing project; project-transition exception applies.

### `project.rename`

- Args: required `projectId`, required non-empty `name`.
- Result: `{ ok: true }`.

## Nodes

### `node.create`

- Args:
  - optional `kind`: `ask` (default), `note`, `file`, `link`, `frame`, `human`, or `prompt`;
  - optional `position: { x, y }`, with non-finite/missing coordinates falling back to `120,80`;
  - optional `question` or alias `text`; optional `response`;
  - `link` requires non-empty `url`;
  - optional `parentId` and `relation` for a new incoming edge;
  - ask/human/prompt may use `instruction`, `rolePrompt`;
  - frame may use `width`/`height`, default `640/420`.
- Result: `{ id, node }` with the final stored node.
- Side effects: creates one undoable graph change; with `parentId`, validates the edge and runs auto-layout. Material/link creation logs a material event. A link also fetches the URL into the node asynchronously before returning.
- Constraints: frame cannot be parent; note/file/link/frame cannot receive an incoming parent edge.

### `node.update`

- Args: required `nodeId`; updates may be inside `patch` or at top level when `patch` is absent/non-object.
- Allowed data fields:
  - strings: `question`, `response`;
  - string or null: `instruction`, `rolePrompt`, `model`, `frameColor`, `linkUrl`, `linkTitle`;
  - booleans: `isCollapsed`, `archived`, `frameCarry`, `webSearch`, `scholarSearch`, `autoRerun`;
  - enums: `roleMode` = `inherit|set-next|reset`; `highlightMode` = `off|tag|filter`;
  - integer: `autoRerunRounds` from 1 through 5;
  - positive finite node dimensions: `width`, `height`.
- Result: `{ id, node }`.
- Side effects: one undoable graph change. Response edits update the selected response version, edit timestamp, token count, derived summaries, and prune invalid highlights. Question edits update timestamps/version-question association. Setting archived false clears archival fields.
- Notes: unlisted patch fields are ignored after validation of known fields.

### `node.move`

- Args: required `nodeId`; optional `position.x`/`position.y`, each falling back to its current coordinate when missing/non-finite.
- Result: `{ id, position }`.
- Side effects: one undoable graph change. Moving a frame with `frameCarry !== false` also moves non-frame nodes whose centers are inside the frame by the same delta.

### `node.duplicate`

- Args: required `nodeId`.
- Result: `{ id }` for the first newly observed node ID; it can be absent if the store did not create one.
- Side effects: delegates to the store's normal node duplication behavior.

### `node.archive`

- Args: either `nodeIds` array or required `nodeId`; optional `archived`, default true and false only when exactly `false`.
- Result: `{ ids, archived }`.
- Notes: array values are string-coerced by this command. It delegates existence/no-op semantics to the store.

### `node.classify`

- Args: required non-empty `nodeIds`; at least one of:
  - `tagIds`: array, replace semantics, deduplicated; `[]` clears tags;
  - `customTypeId`: existing type ID; `null` clears type.
- Result: `{ nodes: [{ id, tagIds, customTypeId }] }`.
- Side effects: validates all nodes/tags/type before one batch transaction, preventing partial writes.

## Context and organization connections

### `edge.connect`

- Args: required `sourceId`, `targetId`; optional `relation`, default `structural`, allowed `structural|reference|watch`.
- Result: the created edge.
- Side effects: one undoable graph change and a connect event. Structural edges trigger auto-layout; reference/watch do not.
- Constraints: no self-loop, duplicate endpoint pair, invalid material/frame endpoint, or structural cycle. Watch/reference are cross-links and do not define structural ancestry.

### `edge.update`

- Args: required `edgeId` and at least one supported change:
  - `relation: structural|reference|watch`;
  - legacy/convenience `structural: boolean`;
  - `sourceId`, `targetId`;
  - `depth: quote|full`, only for reference/watch;
  - `followsTip: boolean`.
- Result: the updated edge.
- Side effects: rebuilds/validates the edge when relation/endpoints change; one undoable graph change. Layout runs if old or new edge is structural.
- Notes: when `structural: false`, an existing watch remains watch; otherwise it becomes reference.

### `organization.connect`

- Args: required `sourceId`, `targetId`, `kind: parent|jump`.
- Result: created organization relation.
- Side effects: delegates to organization store after duplicate/cycle checks.
- Constraints: no frame endpoint. Parent rejects cycles/self-loops/duplicates; jump rejects invalid/self-loop/duplicate relations according to `checkOrganizationRelation`.

## Materials and highlights

### `attachment.add`

- Args: required `nodeId`, required `attachment` object:
  - required non-empty `name`;
  - optional MIME `type`, default `application/octet-stream`;
  - optional `encoding`, where `base64` decodes bytes and every other/missing value treats `content` as text;
  - optional `content`, default empty string;
  - `size` from raw JSON is not trusted by execution; the created `File` determines actual size.
- CLI convenience: `--node <id> --file <path>` builds the attachment with inferred MIME and UTF-8 for supported text types, otherwise base64.
- Result: `{ id, name, type, size }` for the last stored attachment, or `{ ok: false }` if none was observed.
- Side effects: file ingestion and applicable extraction. Model-backed processing is allowed only when `question.ask` or `node.regenerate` permission is also granted; see the protocol reference.

### `attachment.update`

- Args: required `nodeId`, required `attachmentId`, optional object `patch`.
- Allowed fields: `name`, `extractedText`, `digest`, `renderMode`; all other fields are ignored.
- Result: `{ id: attachmentId }`.
- Notes: delegates attachment existence and patch-value semantics to the store.

### `highlight.add`

- Args: required `nodeId`, required non-empty `text`.
- Result: `{ id }` for the generated highlight.

### `highlight.mode`

- Args: required `nodeId`, required `mode: off|tag|filter`.
- Result: `{ id: nodeId, mode }`.

## Generation

### `question.ask`

- Args: required non-empty `question`; optional `parentId`, `branchContext`, `rolePrompt`; optional `inheritRole` (false only when exactly false); optional `mentions` array, whose values are string-coerced.
- Result: compact finished node.
- Side effects: creates a question node synchronously, then runs generation. Registers a stop handler for the created node.
- Failure: if generation marks the node failed, returns its response text as the error, falling back to `Generation failed`.

### `node.regenerate`

- Args: required `nodeId`.
- Result: compact finished node.
- Side effects: reruns the node and registers a stop handler.

### `generation.stop`

- Args: required `nodeId`.
- Result: `{ id, stopped: true }`.
- Scheduling: bypasses the ordinary serial execution tail so it can run while another command is generating.
- Notes: the result confirms the stop method was invoked, not that every downstream operation rolled back. Its permission never authorizes starting generation.

## Layout, taxonomy, and history

### `canvas.relayout`

- Args: none.
- Result: `{ nodes: [{ id, position }] }` after layout.
- Side effects: uses the store's layout behavior, which preserves structural arrow order and chain alignment rules.

### `node.align`

- Args: optional `nodeIds` array; non-array becomes empty.
- Result: `{ ids }`.
- Side effects: delegates alignment and its validation/no-op semantics to the store.

### `tag.create`

- Args: required non-empty `name`; optional non-empty `color`.
- Result: created tag definition.
- Constraints: normalized name must be unique.

### `tag.rename`

- Args: required `tagId`, required non-empty `name`.
- Result: renamed tag definition.
- Constraints: tag must exist and normalized/case-folded name must be unique.

### `type.create`

- Args: required non-empty `name`; optional non-empty `color`.
- Result: created node-type definition.
- Constraints: normalized name must be unique.

### `type.rename`

- Args: required `typeId`, required non-empty `name`.
- Result: renamed node-type definition.
- Constraints: type must exist and normalized/case-folded name must be unique.

### `history.undo`

- Args: none.
- Result: `{ historyIndex }`.
- Side effects: delegates no-history/no-op behavior to the store.

### `history.redo`

- Args: none.
- Result: `{ historyIndex }`.
- Side effects: delegates no-history/no-op behavior to the store.

## Transfer

### `canvas.export`

- Args: optional `sharedReadonly: boolean`, default false.
- Result: v2 transfer object with `schemaVersion: 2`, `version: 2`, `name`, `exportedAt`, optional `instantiatedFrom`, `nodes`, `edges`, `organizationRelations`, and `taxonomy`.
- Editable result also includes `events`, `transactions`, `undoableTransactionIds`, `redoableTransactionIds`, and `revision`.
- Readonly result sets `sharedReadonly: true` and omits all history fields.
- Side effects: flushes pending transaction and inlines vaulted attachment/history content into the returned transfer. Fails while generation/extraction prevents a stable snapshot.
- CLI convenience: `--output <path>` writes the returned string/JSON after it traverses proxy result retention.

### `project.import`

- Args: complete import object; `schemaVersion` or legacy `version`, default 1. Supported versions are 1 and 2. Optional `name`, `instantiatedFrom`, `sharedReadonly`.
- v1: requires `nodes`, `edges`; imports without organization/taxonomy/history and initializes empty history.
- v2: validates and imports `nodes`, `edges`, optional `organizationRelations`, optional `taxonomy`; editable imports validate `events`, transactions, undo/redo IDs, revision, replay continuity, graph endpoints/cycles, taxonomy references, and organization relations.
- `sharedReadonly: true`: strips/ignores history even if supplied.
- CLI convenience: `--file <path>` parses the JSON file, then overlays any `--json` properties on top.
- Result: `{ id, nodes, edges, organizationRelations, tags, nodeTypes, transactions, revision, sharedReadonly }`.
- Side effects: interns vaulted data, writes a new project snapshot, adopts and activates that project. Project-transition exception applies.

## Destructive commands

These commands require exact delete permission and explicit user intent. Never auto-retry them.

### `project.delete`

- Args: required `projectId`.
- Result: `{ ok: true, activeId }`.
- Side effects: deletes an existing project and may change active project; project-transition exception applies.

### `node.delete`

- Args: `nodeIds` array or required `nodeId`.
- Result: `{ ids }`.
- Notes: values in `nodeIds` are string-coerced; store handles nonexistent IDs and connected-edge cleanup. Re-read before and after because the executor does not prevalidate every array ID.

### `edge.delete`

- Args: `edgeIds` array or required `edgeId`.
- Result: `{ ids }`.
- Notes: values in `edgeIds` are string-coerced; store handles nonexistent IDs. Re-read before and after.

### `organization.delete`

- Args: `relationIds` required non-empty ID array, or required `relationId`.
- Result: `{ ids }`.
- Atomicity: prevalidates the whole set through the store; any unknown relation makes the command fail rather than partially delete.

### `attachment.delete`

- Args: required `nodeId`, required `attachmentId`.
- Result: `{ id: attachmentId }`.
- Notes: node is prevalidated; attachment existence/no-op semantics are delegated to the store.

### `highlight.delete`

- Args: required `nodeId`, required `highlightId`.
- Result: `{ id: highlightId }`.
- Notes: node is prevalidated; highlight existence/no-op semantics are delegated to the store.

### `version.delete`

- Args: required `nodeId`, required non-negative integer `versionIndex`.
- Result: `{ nodeId, versionIndex }`.
- Notes: index bounds beyond non-negative integer validation are delegated to the store.

### `tag.delete`

- Args: required `tagId`.
- Result: `{ id, affectedNodeIds }`.
- Side effects: prevalidates the tag, deletes it, and removes its references from affected nodes in the store transaction.

### `type.delete`

- Args: required `typeId`.
- Result: `{ id, affectedNodeIds }`.
- Side effects: prevalidates the type, deletes it, and removes its references from affected nodes in the store transaction.
