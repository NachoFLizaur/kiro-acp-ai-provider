#!/usr/bin/env node

// src/mcp-bridge.ts
import { createInterface } from "readline";
import * as fs from "fs";
import * as http from "http";
import { randomBytes } from "crypto";
var BRIDGE_ID = randomBytes(4).toString("hex");
var globalCallCounter = 0;
function parseArgs() {
  const args = process.argv.slice(2);
  let toolsPath = "";
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--tools":
        toolsPath = args[++i] ?? "";
        break;
      case "--cwd":
        cwd = args[++i] ?? process.cwd();
        break;
    }
  }
  if (!toolsPath) {
    log("error", "Missing required --tools argument");
    process.exit(1);
  }
  return { toolsPath, cwd };
}
function log(level, ...args) {
  const prefix = `[mcp-bridge][${level}]`;
  process.stderr.write(`${prefix} ${args.map(String).join(" ")}
`);
}
function loadToolsFile(toolsPath) {
  try {
    const raw = fs.readFileSync(toolsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.tools)) {
      throw new Error("tools field must be an array");
    }
    log("info", `Loaded ${parsed.tools.length} tool(s) from ${toolsPath}`);
    return parsed;
  } catch (err) {
    log("error", `Failed to load tools file: ${err}`);
    process.exit(1);
  }
}
function httpPost(url, body, timeoutMs = 31e4, authToken) {
  const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data)
    };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers,
        timeout: timeoutMs
      },
      (res) => {
        let settled = false;
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_SIZE) {
            if (!settled) {
              settled = true;
              reject(new Error("Response too large"));
            }
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          try {
            const responseData = Buffer.concat(chunks).toString();
            resolve(JSON.parse(responseData));
          } catch {
            reject(new Error("Invalid JSON response"));
          }
        });
        res.on("error", (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTP request timed out"));
    });
    req.write(data);
    req.end();
  });
}
var MCPBridgeServer = class {
  tools;
  cwd;
  toolsPath;
  ipcPort;
  ipcSecret;
  ipcHealthy = false;
  initialized = false;
  constructor(tools, cwd, toolsPath, ipcPort, ipcSecret) {
    this.tools = tools;
    this.cwd = cwd;
    this.toolsPath = toolsPath;
    this.ipcPort = ipcPort;
    this.ipcSecret = ipcSecret;
  }
  async handleMessage(msg) {
    if (!("id" in msg) || msg.id === void 0) {
      this.handleNotification(msg);
      return null;
    }
    const request2 = msg;
    try {
      switch (request2.method) {
        case "initialize":
          return this.handleInitialize(request2);
        case "tools/list":
          return this.handleToolsList(request2);
        case "tools/call":
          return await this.handleToolsCall(request2);
        case "ping":
          return { jsonrpc: "2.0", id: request2.id, result: {} };
        default:
          return {
            jsonrpc: "2.0",
            id: request2.id,
            error: {
              code: -32601,
              message: `Method not found: ${request2.method}`
            }
          };
      }
    } catch (err) {
      log("error", `Error handling ${request2.method}:`, err);
      return {
        jsonrpc: "2.0",
        id: request2.id,
        error: {
          code: -32603,
          message: "Internal error"
        }
      };
    }
  }
  handleNotification(msg) {
    switch (msg.method) {
      case "notifications/initialized":
        log("info", "Client sent initialized notification");
        break;
      case "notifications/cancelled":
        log("info", "Client cancelled request:", JSON.stringify(msg.params));
        break;
      default:
        log("debug", `Ignoring notification: ${msg.method}`);
    }
  }
  handleInitialize(request2) {
    this.initialized = true;
    log("info", "Initialize request received");
    return {
      jsonrpc: "2.0",
      id: request2.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: true }
        },
        serverInfo: {
          name: "mcp-bridge",
          version: "1.0.0"
        }
      }
    };
  }
  handleToolsList(request2) {
    try {
      const raw = fs.readFileSync(this.toolsPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tools)) {
        this.tools = parsed.tools;
      }
      if (parsed.ipcPort !== void 0) {
        this.ipcPort = parsed.ipcPort;
      }
      if (parsed.ipcSecret !== void 0) {
        this.ipcSecret = parsed.ipcSecret;
      }
    } catch (err) {
      log("warn", `Failed to re-read tools file on tools/list: ${err}`);
    }
    return {
      jsonrpc: "2.0",
      id: request2.id,
      result: {
        tools: this.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      }
    };
  }
  async handleToolsCall(request2) {
    const params = request2.params;
    if (!params?.name) {
      return {
        jsonrpc: "2.0",
        id: request2.id,
        error: { code: -32602, message: "Missing tool name in params" }
      };
    }
    const toolName = params.name;
    const toolArgs = params.arguments ?? {};
    log("info", `Tool call: ${toolName}`, `args: [${Object.keys(toolArgs).join(", ")}]`);
    const toolDef = this.tools.find((t) => t.name === toolName);
    if (!toolDef) {
      return {
        jsonrpc: "2.0",
        id: request2.id,
        error: { code: -32602, message: `Unknown tool: ${toolName}` }
      };
    }
    return this.delegateToIPC(request2.id, toolName, toolArgs);
  }
  updateTools(tools, ipcPort, ipcSecret) {
    this.tools = tools;
    if (ipcPort !== void 0) {
      this.ipcPort = ipcPort;
    }
    if (ipcSecret !== void 0) {
      this.ipcSecret = ipcSecret;
    }
    log("info", `Updated tool list: ${tools.length} tool(s)${ipcPort ? ` (ipcPort: ${ipcPort})` : ""}`);
    sendNotification("notifications/tools/list_changed", {});
  }
  // -------------------------------------------------------------------------
  // IPC delegation
  // -------------------------------------------------------------------------
  async checkHealth() {
    if (!this.ipcPort) return false;
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.ipcPort,
          path: "/health",
          method: "GET",
          timeout: 5e3
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.status === "ok");
            } catch {
              resolve(false);
            }
          });
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }
  async delegateToIPC(requestId, toolName, args) {
    if (!this.ipcPort) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          content: [
            {
              type: "text",
              text: `Tool "${toolName}" cannot be executed: IPC not configured.`
            }
          ],
          isError: true
        }
      };
    }
    try {
      if (!this.ipcHealthy) {
        const healthy = await this.checkHealth();
        if (!healthy) {
          return {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [
                {
                  type: "text",
                  text: `Tool "${toolName}" requires the harness runtime but the IPC server is not responding. The server may have crashed or not started yet.`
                }
              ],
              isError: true
            }
          };
        }
        this.ipcHealthy = true;
      }
      const response = await httpPost(
        `http://127.0.0.1:${this.ipcPort}/tool/pending`,
        { callId: `${BRIDGE_ID}-${++globalCallCounter}`, toolName, args },
        31e4,
        this.ipcSecret
      );
      if (response.status === "success") {
        if (response.content && response.content.length > 0) {
          const mcpContent = response.content.map((block) => {
            if (block.type === "image" && block.data && block.mimeType) {
              return { type: "image", data: block.data, mimeType: block.mimeType };
            }
            return { type: "text", text: block.text ?? "" };
          });
          return {
            jsonrpc: "2.0",
            id: requestId,
            result: { content: mcpContent }
          };
        }
        return {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            content: [{ type: "text", text: response.result ?? "" }]
          }
        };
      } else {
        return {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            content: [{ type: "text", text: `Error: ${response.error ?? "Unknown error"}` }],
            isError: true
          }
        };
      }
    } catch (err) {
      this.ipcHealthy = false;
      const message = err instanceof Error ? err.message : String(err);
      log("error", `IPC delegation failed for ${toolName}:`, message);
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          content: [{ type: "text", text: "Tool execution failed" }],
          isError: true
        }
      };
    }
  }
};
function sendResponse(response) {
  const line = JSON.stringify(response) + "\n";
  process.stdout.write(line);
}
function sendNotification(method, params) {
  const msg = { jsonrpc: "2.0", method, params };
  const line = JSON.stringify(msg) + "\n";
  process.stdout.write(line);
}
function watchToolsFile(toolsPath, server) {
  try {
    let debounceTimer = null;
    fs.watch(toolsPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          const raw = fs.readFileSync(toolsPath, "utf-8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed.tools)) {
            server.updateTools(parsed.tools, parsed.ipcPort, parsed.ipcSecret);
          }
        } catch (err) {
          log("warn", `Failed to reload tools file: ${err}`);
        }
      }, 100);
    });
    log("info", `Watching tools file for changes: ${toolsPath}`);
  } catch (err) {
    log("warn", `Could not watch tools file: ${err}`);
  }
}
async function main() {
  const { toolsPath, cwd } = parseArgs();
  log("info", `Starting MCP bridge server (cwd: ${cwd})`);
  log("info", `Tools file: ${toolsPath}`);
  const toolsFile = loadToolsFile(toolsPath);
  const effectiveCwd = toolsFile.cwd ?? cwd;
  const server = new MCPBridgeServer(toolsFile.tools, effectiveCwd, toolsPath, toolsFile.ipcPort, toolsFile.ipcSecret);
  watchToolsFile(toolsPath, server);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    try {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        log("warn", "Received non-JSON input:", trimmed.slice(0, 100));
        return;
      }
      const response = await server.handleMessage(msg);
      if (response) {
        sendResponse(response);
      }
    } catch (err) {
      log("error", "Failed to handle message", String(err));
    }
  });
  rl.on("close", () => {
    log("info", "stdin closed, shutting down");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log("info", "Received SIGTERM, shutting down");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    log("info", "Received SIGINT, shutting down");
    process.exit(0);
  });
  log("info", "MCP bridge server ready");
}
main().catch((err) => {
  log("error", "Fatal error:", err);
  process.exit(1);
});
//# sourceMappingURL=mcp-bridge.js.map