// ---------------------------------------------------------------------------
// MCP Bridge — Tool Definitions
// ---------------------------------------------------------------------------

export interface MCPToolInputSchema {
  type: "object"
  properties: Record<string, { type: string; description?: string; default?: unknown; enum?: unknown[] }>
  required?: string[]
  additionalProperties?: boolean
}

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: MCPToolInputSchema
}

export interface MCPToolsFile {
  tools: MCPToolDefinition[]
  cwd?: string
  ipcPort?: number
  ipcSecret?: string
}

