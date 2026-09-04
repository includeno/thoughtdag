// Shared command catalog for the settings UI, local proxy and standalone CLI.
// Keep this file data-only so it can be imported by both Vite and Node.
export const CLI_COMMAND_GROUPS = [
  {
    id: 'inspect',
    commands: ['project.list', 'canvas.get', 'node.list', 'node.get', 'edge.list'],
  },
  {
    id: 'projects',
    commands: ['project.create', 'project.switch', 'project.rename'],
  },
  {
    id: 'nodes',
    commands: ['node.create', 'node.update', 'node.move', 'node.duplicate', 'node.archive', 'node.classify'],
  },
  {
    id: 'connections',
    commands: ['edge.connect', 'edge.update', 'organization.connect'],
  },
  {
    id: 'materials',
    commands: ['attachment.add', 'attachment.update', 'highlight.add', 'highlight.mode'],
  },
  {
    id: 'generation',
    commands: ['question.ask', 'node.regenerate', 'generation.stop'],
  },
  {
    id: 'organize',
    commands: [
      'canvas.relayout', 'node.align',
      'tag.create', 'tag.rename', 'type.create', 'type.rename',
      'history.undo', 'history.redo',
    ],
  },
  {
    id: 'transfer',
    commands: ['canvas.export', 'project.import'],
  },
  {
    id: 'delete',
    danger: true,
    commands: [
      'project.delete',
      'node.delete',
      'edge.delete',
      'organization.delete',
      'attachment.delete',
      'highlight.delete',
      'version.delete',
      'tag.delete',
      'type.delete',
    ],
  },
];

export const CLI_COMMAND_IDS = CLI_COMMAND_GROUPS.flatMap((group) => group.commands);

export const CLI_DEFAULT_PERMISSIONS = CLI_COMMAND_GROUPS
  .filter((group) => !group.danger)
  .flatMap((group) => group.commands);

export const CLI_DANGER_COMMANDS = CLI_COMMAND_GROUPS
  .filter((group) => group.danger)
  .flatMap((group) => group.commands);

// These permissions authorize starting model work. `generation.stop` belongs
// to the same UI group but is deliberately excluded: permission to stop work
// must never be interpreted as permission to start an implicit generation.
export const CLI_GENERATIVE_COMMANDS = ['question.ask', 'node.regenerate'];

export function cliPermissionsAllowGenerativeProcessing(permissions) {
  const granted = new Set(Array.isArray(permissions) ? permissions : []);
  return CLI_GENERATIVE_COMMANDS.some((command) => granted.has(command));
}
