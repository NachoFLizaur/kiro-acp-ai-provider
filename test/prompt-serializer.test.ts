import { describe, test, expect } from "bun:test"
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider"
import {
  serializeMessages,
  systemPromptText,
  nonSystemMessages,
  REPLAY_TOOL_RESULT_MAX_CHARS,
} from "../src/prompt-serializer"

const user = (text: string): LanguageModelV3Message => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string): LanguageModelV3Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const png = Buffer.from("fake-png").toString("base64")

const CHECKPOINT = `<conversation-checkpoint>
<summary>
## Objective
Ship it.
</summary>
<recent-context>
[User]: hi
</recent-context>
</conversation-checkpoint>`

function texts(messages: LanguageModelV3Message[], imagesAsBlocks = true): string {
  const { blocks } = serializeMessages(messages, { imagesAsBlocks })
  expect(blocks.every((b) => b.type === "text")).toBe(true)
  return blocks.map((b) => b.text).join("\n\n")
}

describe("systemPromptText", () => {
  test("undefined when no system message", () => {
    expect(systemPromptText([user("a")])).toBeUndefined()
  })

  test("joins multiple system messages with a blank line", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "one" },
      user("x"),
      { role: "system", content: "two" },
    ]
    expect(systemPromptText(prompt)).toBe("one\n\ntwo")
  })

  test("nonSystemMessages drops system entries and keeps order", () => {
    const prompt: LanguageModelV3Prompt = [{ role: "system", content: "s" }, user("a"), assistant("b")]
    expect(nonSystemMessages(prompt).map((m) => m.role)).toEqual(["user", "assistant"])
  })
})

describe("serializeMessages", () => {
  test("empty input returns no blocks", () => {
    expect(serializeMessages([], { imagesAsBlocks: true })).toEqual({ blocks: [] })
  })

  test("single user text is verbatim, no label", () => {
    const { blocks } = serializeMessages([user("hi")], { imagesAsBlocks: true })
    expect(blocks).toEqual([{ type: "text", text: "hi" }])
  })

  test("checkpoint followed by user text: both labeled, checkpoint verbatim", () => {
    const out = texts([user(CHECKPOINT), user("next")])
    expect(out).toBe(`[User]\n${CHECKPOINT}\n\n[User]\nnext`)
  })

  test("assistant text", () => {
    const out = texts([user("q"), assistant("a")])
    expect(out).toBe("[User]\nq\n\n[Assistant]\na")
  })

  test("assistant reasoning is omitted", () => {
    const msg: LanguageModelV3Message = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking hard" },
        { type: "text", text: "answer" },
      ],
    }
    const out = texts([user("q"), msg])
    expect(out).not.toContain("thinking hard")
    expect(out).toContain("[Assistant]\nanswer")
  })

  test("tool call and tool result render with name and full input", () => {
    const call: LanguageModelV3Message = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "/x", limit: 3 } }],
    }
    const result: LanguageModelV3Message = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "contents" } }],
    }
    const out = texts([user("q"), call, result])
    expect(out).toContain('[Assistant tool call] read({"path":"/x","limit":3})')
    expect(out).toContain("[Tool result: read]\ncontents")
  })

  test("tool-call with string input is passed through", () => {
    const call: LanguageModelV3Message = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: '{"cmd":"ls"}' }],
    }
    expect(texts([user("q"), call])).toContain('[Assistant tool call] bash({"cmd":"ls"})')
  })

  test("tool error variants", () => {
    const tool: LanguageModelV3Message = {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "1", toolName: "a", output: { type: "error-text", value: "boom" } },
        { type: "tool-result", toolCallId: "2", toolName: "b", output: { type: "error-json", value: { code: 7 } } },
        { type: "tool-result", toolCallId: "3", toolName: "c", output: { type: "execution-denied", reason: "nope" } },
      ],
    }
    const out = texts([user("q"), tool])
    expect(out).toContain("[Tool error: a]\nboom")
    expect(out).toContain('[Tool error: b]\n{"code":7}')
    expect(out).toContain("[Tool error: c]\nExecution denied: nope")
  })

  test("json tool result is stringified", () => {
    const tool: LanguageModelV3Message = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "1", toolName: "j", output: { type: "json", value: [1, 2] } }],
    }
    expect(texts([user("q"), tool])).toContain("[Tool result: j]\n[1,2]")
  })

  test("content tool result: text concatenated, images and files as placeholders", () => {
    const tool: LanguageModelV3Message = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "1",
          toolName: "shot",
          output: {
            type: "content",
            value: [
              { type: "text", text: "line one" },
              { type: "file-data", data: png, mediaType: "image/png" },
              { type: "file-data", data: "AA==", mediaType: "application/pdf" },
            ],
          },
        },
      ],
    }
    const out = texts([user("q"), tool])
    expect(out).toContain("[Tool result: shot]\nline one\n[Image: image/png]\n[File: application/pdf]")
    expect(out).not.toContain(png)
  })

  test("tool result longer than max is truncated with marker", () => {
    const value = "x".repeat(REPLAY_TOOL_RESULT_MAX_CHARS + 50)
    const tool: LanguageModelV3Message = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "1", toolName: "t", output: { type: "text", value } }],
    }
    const out = texts([user("q"), tool])
    expect(out).toContain("x".repeat(REPLAY_TOOL_RESULT_MAX_CHARS) + "\n…[truncated 50 chars]")
    expect(out).not.toContain("x".repeat(REPLAY_TOOL_RESULT_MAX_CHARS + 1))
  })

  test("image in last user message becomes an image block that splits text", () => {
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "file", data: png, mediaType: "image/*" },
        { type: "text", text: "after" },
      ],
    }
    const { blocks } = serializeMessages([msg], { imagesAsBlocks: true })
    expect(blocks).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: png, mimeType: "image/jpeg" },
      { type: "text", text: "after" },
    ])
  })

  test("image in an earlier user message is a placeholder; last one is a block", () => {
    const withImage: LanguageModelV3Message = {
      role: "user",
      content: [{ type: "file", data: png, mediaType: "image/png" }],
    }
    const { blocks } = serializeMessages([withImage, assistant("ok"), withImage], { imagesAsBlocks: true })
    expect(blocks[0]).toEqual({ type: "text", text: "[User]\n[Image: image/png]\n\n[Assistant]\nok\n\n[User]" })
    expect(blocks[1]).toEqual({ type: "image", data: png, mimeType: "image/png" })
    expect(blocks).toHaveLength(2)
  })

  test("imagesAsBlocks false renders every image as a placeholder", () => {
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [{ type: "file", data: png, mediaType: "image/png" }],
    }
    expect(serializeMessages([msg], { imagesAsBlocks: false })).toEqual({
      blocks: [{ type: "text", text: "[Image: image/png]" }],
    })
  })

  test("non-image file in user message becomes a placeholder with filename", () => {
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "file", data: "AA==", mediaType: "application/pdf", filename: "spec.pdf" },
      ],
    }
    expect(texts([msg])).toBe("see\n[File: application/pdf spec.pdf]")
  })

  test("adjacent text sections merge into one block", () => {
    const { blocks } = serializeMessages([user("a"), assistant("b"), user("c")], { imagesAsBlocks: true })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe("[User]\na\n\n[Assistant]\nb\n\n[User]\nc")
  })

  test("Uint8Array image data is base64-encoded", () => {
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [{ type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }],
    }
    const { blocks } = serializeMessages([msg], { imagesAsBlocks: true })
    expect(blocks[0]).toEqual({ type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" })
  })
})
