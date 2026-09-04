export interface CliCommandGroup {
  id: string;
  danger?: boolean;
  commands: string[];
}

export const CLI_COMMAND_GROUPS: CliCommandGroup[];
export const CLI_COMMAND_IDS: string[];
export const CLI_DEFAULT_PERMISSIONS: string[];
export const CLI_DANGER_COMMANDS: string[];
export const CLI_GENERATIVE_COMMANDS: string[];
export function cliPermissionsAllowGenerativeProcessing(permissions: unknown): boolean;
