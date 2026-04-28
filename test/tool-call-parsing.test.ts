import { describe, test, expect } from "bun:test"
import { parseToolCallNotification } from "../src/kiro-acp-model"

// ---------------------------------------------------------------------------
// Tests for Task 07: Broader Tool Call Parsing
//
// parseToolCallNotification() is now exported for direct unit testing.
// It's a pure function with no side effects.
// ---------------------------------------------------------------------------

describe("parseToolCallNotification", () => {
  test("extracts toolCallId from primary field", () => {
    // Arrange
    const update = { toolCallId: "tc-1" }

    // Act
    const result = parseToolCallNotification(update)

    // Assert
    expect(result.toolCallId).toBe("tc-1")
  })

  test("falls back to callId when toolCallId missing", () => {
    // Arrange
    const update = { callId: "tc-2" }

    // Act
    const result = parseToolCallNotification(update)

    // Assert
    expect(result.toolCallId).toBe("tc-2")
  })

  test("prefers toolCallId over callId", () => {
    // Arrange
    const update = { toolCallId: "tc-1", callId: "tc-2" }

    // Act
    const result = parseToolCallNotification(update)

    // Assert
    expect(result.toolCallId).toBe("tc-1")
  })

  test("extracts toolName from title regex", () => {
    // Arrange
    const update = { title: "Running: @server/myTool" }

    // Act
    const result = parseToolCallNotification(update)

    // Assert
    expect(result.toolName).toBe("myTool")
  })

  test("falls back to toolName field", () => {
    // Arrange
    const update = { toolName: "myTool" }

    // Act
    const result = parseToolCallNotification(update)

    // Assert
    expect(result.toolName).toBe("myTool")
  })

  test("falls back to name with path extraction", () => {
    // Arrange
    const update = { name: "@server/myTool" }

    // Act
    const result = parseToolCallNotification(update)

    // Assert
    expect(result.toolName).toBe("myTool")
  })

  test("uses full name when no slashes", () => {
    // Arrange
    const update = { name: "myTool" }

    // Act
    const result = parseToolCallNotification(update)

    // Assert
    expect(result.toolName).toBe("myTool")
  })

  test("returns undefined for empty update", () => {
    // Arrange
    const update = {}

    // Act
    const result = parseToolCallNotification(update)

    // Assert
    expect(result.toolCallId).toBeUndefined()
    expect(result.toolName).toBeUndefined()
  })

  test("extracts args from rawInput excluding __ prefixed", () => {
    // Arrange
    const update = {
      rawInput: { a: 1, __b: 2, c: "hello", __internal: true },
    }

    // Act
    const result = parseToolCallNotification(update)

    // Assert
    expect(result.args).toEqual({ a: 1, c: "hello" })
    expect(result.args).not.toHaveProperty("__b")
    expect(result.args).not.toHaveProperty("__internal")
  })
})
