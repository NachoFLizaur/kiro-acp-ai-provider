import { describe, test, expect } from "bun:test"
import { getDefaultTools, type MCPToolDefinition } from "../src/mcp-bridge-tools"

describe("getDefaultTools()", () => {
  test("returns an array of tool definitions", () => {
    const tools = getDefaultTools()
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test("returns the expected set of tools", () => {
    const tools = getDefaultTools()
    const names = tools.map((t) => t.name)

    expect(names).toContain("bash")
    expect(names).toContain("read_file")
    expect(names).toContain("write_file")
    expect(names).toContain("edit_file")
    expect(names).toContain("glob")
    expect(names).toContain("grep")
    expect(names).toContain("list_directory")
  })

  test("returns exactly 7 tools", () => {
    const tools = getDefaultTools()
    expect(tools).toHaveLength(7)
  })

  test("each tool has name, description, and inputSchema", () => {
    const tools = getDefaultTools()

    for (const tool of tools) {
      expect(typeof tool.name).toBe("string")
      expect(tool.name.length).toBeGreaterThan(0)

      expect(typeof tool.description).toBe("string")
      expect(tool.description.length).toBeGreaterThan(0)

      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe("object")
      expect(typeof tool.inputSchema.properties).toBe("object")
    }
  })

  test("each tool has required fields defined", () => {
    const tools = getDefaultTools()

    for (const tool of tools) {
      if (tool.inputSchema.required) {
        expect(Array.isArray(tool.inputSchema.required)).toBe(true)
        // All required fields should exist in properties
        for (const req of tool.inputSchema.required) {
          expect(tool.inputSchema.properties).toHaveProperty(req)
        }
      }
    }
  })

  describe("bash tool", () => {
    test("has command as required parameter", () => {
      const tools = getDefaultTools()
      const bash = tools.find((t) => t.name === "bash")!

      expect(bash.inputSchema.required).toContain("command")
      expect(bash.inputSchema.properties.command.type).toBe("string")
    })

    test("has optional timeout and workdir parameters", () => {
      const tools = getDefaultTools()
      const bash = tools.find((t) => t.name === "bash")!

      expect(bash.inputSchema.properties.timeout).toBeDefined()
      expect(bash.inputSchema.properties.timeout.type).toBe("number")

      expect(bash.inputSchema.properties.workdir).toBeDefined()
      expect(bash.inputSchema.properties.workdir.type).toBe("string")
    })
  })

  describe("read_file tool", () => {
    test("has filePath as required parameter", () => {
      const tools = getDefaultTools()
      const readFile = tools.find((t) => t.name === "read_file")!

      expect(readFile.inputSchema.required).toContain("filePath")
      expect(readFile.inputSchema.properties.filePath.type).toBe("string")
    })

    test("has optional offset and limit parameters", () => {
      const tools = getDefaultTools()
      const readFile = tools.find((t) => t.name === "read_file")!

      expect(readFile.inputSchema.properties.offset).toBeDefined()
      expect(readFile.inputSchema.properties.offset.type).toBe("number")

      expect(readFile.inputSchema.properties.limit).toBeDefined()
      expect(readFile.inputSchema.properties.limit.type).toBe("number")
    })
  })

  describe("write_file tool", () => {
    test("has filePath and content as required parameters", () => {
      const tools = getDefaultTools()
      const writeFile = tools.find((t) => t.name === "write_file")!

      expect(writeFile.inputSchema.required).toContain("filePath")
      expect(writeFile.inputSchema.required).toContain("content")
    })
  })

  describe("edit_file tool", () => {
    test("has filePath, oldString, newString as required parameters", () => {
      const tools = getDefaultTools()
      const editFile = tools.find((t) => t.name === "edit_file")!

      expect(editFile.inputSchema.required).toContain("filePath")
      expect(editFile.inputSchema.required).toContain("oldString")
      expect(editFile.inputSchema.required).toContain("newString")
    })

    test("has optional replaceAll parameter", () => {
      const tools = getDefaultTools()
      const editFile = tools.find((t) => t.name === "edit_file")!

      expect(editFile.inputSchema.properties.replaceAll).toBeDefined()
      expect(editFile.inputSchema.properties.replaceAll.type).toBe("boolean")
    })
  })

  describe("glob tool", () => {
    test("has pattern as required parameter", () => {
      const tools = getDefaultTools()
      const glob = tools.find((t) => t.name === "glob")!

      expect(glob.inputSchema.required).toContain("pattern")
      expect(glob.inputSchema.properties.pattern.type).toBe("string")
    })

    test("has optional path parameter", () => {
      const tools = getDefaultTools()
      const glob = tools.find((t) => t.name === "glob")!

      expect(glob.inputSchema.properties.path).toBeDefined()
      expect(glob.inputSchema.properties.path.type).toBe("string")
    })
  })

  describe("grep tool", () => {
    test("has pattern as required parameter", () => {
      const tools = getDefaultTools()
      const grep = tools.find((t) => t.name === "grep")!

      expect(grep.inputSchema.required).toContain("pattern")
      expect(grep.inputSchema.properties.pattern.type).toBe("string")
    })

    test("has optional path and include parameters", () => {
      const tools = getDefaultTools()
      const grep = tools.find((t) => t.name === "grep")!

      expect(grep.inputSchema.properties.path).toBeDefined()
      expect(grep.inputSchema.properties.include).toBeDefined()
    })
  })

  describe("list_directory tool", () => {
    test("has path as required parameter", () => {
      const tools = getDefaultTools()
      const listDir = tools.find((t) => t.name === "list_directory")!

      expect(listDir.inputSchema.required).toContain("path")
      expect(listDir.inputSchema.properties.path.type).toBe("string")
    })
  })

  test("returns a new array on each call (no shared state)", () => {
    const tools1 = getDefaultTools()
    const tools2 = getDefaultTools()

    expect(tools1).not.toBe(tools2)
    expect(tools1).toEqual(tools2)
  })
})
