// ---------------------------------------------------------------------------
// MCP Bridge — Tool Definitions
// ---------------------------------------------------------------------------

/** JSON Schema for a tool's input parameters. */
export interface MCPToolInputSchema {
  type: "object"
  properties: Record<string, { type: string; description?: string; default?: unknown; enum?: unknown[] }>
  required?: string[]
  additionalProperties?: boolean
}

/** A tool definition as served by the MCP bridge. */
export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: MCPToolInputSchema
}

/** Shape of the JSON file that the parent process writes for the bridge. */
export interface MCPToolsFile {
  tools: MCPToolDefinition[]
  /** Working directory for tool execution. */
  cwd?: string
  /** Port number for the IPC server (tool delegation). */
  ipcPort?: number
}

/**
 * Returns the default set of tool definitions for the MCP bridge.
 * These are the tools kiro-cli's model can call.
 */
export function getDefaultTools(): MCPToolDefinition[] {
  return [
    {
      name: "bash",
      description:
        "Execute a bash command in the terminal. Use for running commands, installing packages, running tests, etc. The command runs in the project working directory.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          timeout: {
            type: "number",
            description: "Optional timeout in milliseconds (default: 30000)",
          },
          workdir: {
            type: "string",
            description:
              "Working directory for the command. Defaults to the project root. Use this instead of cd.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description:
        "Read the contents of a file. Returns the file content with line numbers prefixed. Supports offset and limit for reading specific sections of large files.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute path to the file to read",
          },
          offset: {
            type: "number",
            description: "Line number to start reading from (1-indexed, default: 1)",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read (default: 2000)",
          },
        },
        required: ["filePath"],
      },
    },
    {
      name: "write_file",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Creates parent directories as needed.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute path to the file to write",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["filePath", "content"],
      },
    },
    {
      name: "edit_file",
      description:
        "Perform an exact string replacement in a file. The oldString must match exactly (including whitespace and indentation). Use replaceAll to replace every occurrence.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute path to the file to edit",
          },
          oldString: {
            type: "string",
            description: "The exact text to find and replace",
          },
          newString: {
            type: "string",
            description: "The replacement text",
          },
          replaceAll: {
            type: "boolean",
            description: "Replace all occurrences (default: false)",
          },
        },
        required: ["filePath", "oldString", "newString"],
      },
    },
    {
      name: "glob",
      description:
        'Find files matching a glob pattern. Returns matching file paths sorted by modification time. Example patterns: "**/*.ts", "src/**/*.test.ts".',
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The glob pattern to match files against",
          },
          path: {
            type: "string",
            description:
              "The directory to search in. Defaults to the project root.",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "grep",
      description:
        "Search file contents using a regular expression. Returns file paths and line numbers of matches. Supports full regex syntax.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The regex pattern to search for",
          },
          path: {
            type: "string",
            description: "The directory to search in. Defaults to the project root.",
          },
          include: {
            type: "string",
            description:
              'File pattern to include in the search (e.g. "*.ts", "*.{ts,tsx}")',
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "list_directory",
      description:
        "List the contents of a directory. Returns entries with trailing / for subdirectories.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the directory to list",
          },
        },
        required: ["path"],
      },
    },
  ]
}
