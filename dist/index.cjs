"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ACPClient: () => ACPClient,
  KiroACPConnectionError: () => KiroACPConnectionError,
  KiroACPError: () => KiroACPError,
  KiroACPLanguageModel: () => KiroACPLanguageModel,
  createIPCServer: () => createIPCServer,
  createKiroAcp: () => createKiroAcp,
  generateAgentConfig: () => generateAgentConfig,
  getQuota: () => getQuota,
  listModels: () => listModels,
  verifyAuth: () => verifyAuth,
  writeAgentConfig: () => writeAgentConfig
});
module.exports = __toCommonJS(index_exports);

// src/acp-client.ts
var import_node_child_process2 = require("child_process");
var import_node_readline = require("readline");
var import_node_crypto2 = require("crypto");
var import_node_url = require("url");
var import_node_path3 = require("path");
var import_node_fs3 = require("fs");
var import_node_os2 = require("os");

// src/agent-config.ts
var import_node_fs = require("fs");
var import_node_path = require("path");
function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function generateAgentConfig(options) {
  const toolsBaseName = (0, import_node_path.basename)(options.toolsFilePath, ".json");
  const segments = toolsBaseName.split("-");
  const streamSuffix = segments.length >= 3 ? segments[segments.length - 1] : "";
  const mcpServerName = streamSuffix ? `${options.name ?? "kiro-acp"}-tools-${streamSuffix}` : `${options.name ?? "kiro-acp"}-tools`;
  const mcpServerRef = `@${mcpServerName}`;
  return {
    name: options.name ?? "kiro-acp",
    tools: [mcpServerRef],
    allowedTools: [mcpServerRef],
    includeMcpJson: false,
    mcpServers: {
      [mcpServerName]: {
        command: "node",
        args: [options.mcpBridgePath, "--tools", options.toolsFilePath],
        cwd: options.cwd
      }
    },
    prompt: options.prompt ?? `You are a coding assistant that operates under different agent identities. Your identity, behavior, and instructions are defined by the <system_instructions> block included with each request. Always follow the latest <system_instructions> as your primary directive \u2014 they define who you are, how you behave, and what tools you should use. If no <system_instructions> are present, act as a helpful coding assistant that follows instructions precisely and uses tools proactively. If a tool call fails, retry it or try alternative approaches \u2014 do not assume a tool is permanently unavailable based on a single failure.`,
    ...options.model ? { model: options.model } : {}
  };
}
function writeAgentConfig(dir, name, config) {
  const safeName = sanitizeName(name);
  const agentsDir = (0, import_node_path.join)(dir, ".kiro", "agents");
  const filePath = (0, import_node_path.join)(agentsDir, `${safeName}.json`);
  (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(filePath), { recursive: true, mode: 448 });
  const tmpPath = filePath + ".tmp";
  (0, import_node_fs.writeFileSync)(tmpPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 384 });
  (0, import_node_fs.renameSync)(tmpPath, filePath);
  return filePath;
}

// src/ipc-server.ts
var http = __toESM(require("http"), 1);
var import_node_crypto = require("crypto");

// src/lane-router.ts
var CORRELATION_BUFFER_TIMEOUT_MS = 2e3;
var CORRELATION_TTL_MS = 5 * 60 * 1e3;
function sortKeys(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}
function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
var LaneRouter = class {
  lanes = /* @__PURE__ */ new Map();
  bufferedCalls = [];
  // -------------------------------------------------------------------------
  // Lane lifecycle
  // -------------------------------------------------------------------------
  register(sessionId, handler) {
    this.lanes.set(sessionId, {
      sessionId,
      handler,
      pendingCorrelations: /* @__PURE__ */ new Map()
    });
    this.drainBufferedCalls();
  }
  unregister(sessionId) {
    this.lanes.delete(sessionId);
  }
  /** Update the handler for an existing lane (used during resumption). */
  updateHandler(sessionId, handler) {
    const lane = this.lanes.get(sessionId);
    if (lane) {
      lane.handler = handler;
    }
  }
  // -------------------------------------------------------------------------
  // Correlation
  // -------------------------------------------------------------------------
  /**
   * Record a pending correlation from an ACP tool_call notification.
   * Creates a "reservation" that the next matching IPC call should be
   * routed to this session's lane.
   */
  correlate(sessionId, toolCallId, toolName, args) {
    const lane = this.lanes.get(sessionId);
    if (!lane) return;
    const now = Date.now();
    for (const [id, correlation] of lane.pendingCorrelations) {
      if (now - correlation.timestamp > CORRELATION_TTL_MS) {
        lane.pendingCorrelations.delete(id);
      }
    }
    lane.pendingCorrelations.set(toolCallId, {
      toolCallId,
      toolName,
      args,
      timestamp: now
    });
    this.drainBufferedCalls();
  }
  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------
  route(call) {
    if (this.lanes.size === 1) {
      const [, lane] = [...this.lanes][0];
      this.consumeCorrelation(lane, call);
      lane.handler(call);
      return;
    }
    if (this.lanes.size === 0) {
      this.bufferCall(call);
      return;
    }
    const match = this.findMatchingLane(call);
    if (match) {
      this.consumeCorrelation(match, call);
      match.handler(call);
      return;
    }
    this.bufferCall(call);
  }
  // -------------------------------------------------------------------------
  // Internal: matching
  // -------------------------------------------------------------------------
  /**
   * Find a lane with a matching correlation (toolName + args deep equality).
   * Uses oldest correlation timestamp as tiebreaker (FIFO).
   */
  findMatchingLane(call) {
    let bestLane = null;
    let bestTimestamp = Infinity;
    for (const [, lane] of this.lanes) {
      for (const [, correlation] of lane.pendingCorrelations) {
        if (correlation.toolName === call.toolName && deepEqual(correlation.args, call.args) && correlation.timestamp < bestTimestamp) {
          bestLane = lane;
          bestTimestamp = correlation.timestamp;
        }
      }
    }
    return bestLane;
  }
  /** Remove the first matching correlation to prevent double-matching. */
  consumeCorrelation(lane, call) {
    for (const [id, correlation] of lane.pendingCorrelations) {
      if (correlation.toolName === call.toolName && deepEqual(correlation.args, call.args)) {
        lane.pendingCorrelations.delete(id);
        return;
      }
    }
  }
  // -------------------------------------------------------------------------
  // Internal: buffering
  // -------------------------------------------------------------------------
  /**
   * Buffer an IPC call with no matching correlation yet.
   * The ACP notification may arrive slightly after the IPC call.
   * On timeout, falls back to the most recently registered lane.
   */
  bufferCall(call) {
    const timer = setTimeout(() => {
      const idx = this.bufferedCalls.findIndex((b) => b.call.callId === call.callId);
      if (idx !== -1) {
        this.bufferedCalls.splice(idx, 1);
        this.routeFallback(call);
      }
    }, CORRELATION_BUFFER_TIMEOUT_MS);
    this.bufferedCalls.push({ call, timestamp: Date.now(), timer });
  }
  drainBufferedCalls() {
    let i = 0;
    while (i < this.bufferedCalls.length) {
      const buffered = this.bufferedCalls[i];
      if (this.lanes.size === 1) {
        const [, lane] = [...this.lanes][0];
        clearTimeout(buffered.timer);
        this.bufferedCalls.splice(i, 1);
        this.consumeCorrelation(lane, buffered.call);
        lane.handler(buffered.call);
        continue;
      }
      const match = this.findMatchingLane(buffered.call);
      if (match) {
        clearTimeout(buffered.timer);
        this.bufferedCalls.splice(i, 1);
        this.consumeCorrelation(match, buffered.call);
        match.handler(buffered.call);
      } else {
        i++;
      }
    }
  }
  /** Fallback: route to the most recently registered lane. */
  routeFallback(call) {
    let lastLane = null;
    for (const [, lane] of this.lanes) {
      lastLane = lane;
    }
    if (lastLane) {
      lastLane.handler(call);
    }
  }
  getLaneCount() {
    return this.lanes.size;
  }
  getBufferedCallCount() {
    return this.bufferedCalls.length;
  }
  clear() {
    for (const buffered of this.bufferedCalls) {
      clearTimeout(buffered.timer);
    }
    this.bufferedCalls.length = 0;
    this.lanes.clear();
  }
};

// src/ipc-server.ts
function readBody(req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let totalSize = 0;
    req.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        if (!settled) {
          settled = true;
          reject(new Error("PAYLOAD_TOO_LARGE"));
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
function respond(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json)
  });
  res.end(json);
}
var PENDING_CALL_TIMEOUT_MS = 3e5;
var MAX_BODY_SIZE = 10 * 1024 * 1024;
var MAX_PENDING_CALLS = 1e3;
var IPCServerImpl = class {
  server = null;
  port = null;
  host;
  startTime = 0;
  pendingCalls = /* @__PURE__ */ new Map();
  laneRouter = new LaneRouter();
  secret;
  constructor(options = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.secret = (0, import_node_crypto.randomBytes)(32).toString("hex");
  }
  async start() {
    if (this.server) {
      throw new Error("IPC server is already running");
    }
    this.startTime = Date.now();
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
            respond(res, 413, { error: "Payload too large" });
          } else {
            respond(res, 500, { error: "Internal server error" });
          }
        }
      });
    });
    return new Promise((resolve, reject) => {
      this.server.listen(0, this.host, () => {
        const addr = this.server.address();
        this.port = addr.port;
        resolve(this.port);
      });
      this.server.on("error", reject);
    });
  }
  async stop() {
    for (const [callId, entry] of this.pendingCalls) {
      clearTimeout(entry.timer);
      entry.resolve({
        status: "error",
        error: "IPC server shutting down",
        code: "SERVER_SHUTDOWN"
      });
    }
    this.pendingCalls.clear();
    this.laneRouter.clear();
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
      this.port = null;
    }
  }
  getPort() {
    return this.port;
  }
  getSecret() {
    return this.secret;
  }
  getPendingCount() {
    return this.pendingCalls.size;
  }
  getLaneRouter() {
    return this.laneRouter;
  }
  resolveToolResult(request) {
    const { callId, result, isError } = request;
    const pending = this.pendingCalls.get(callId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCalls.delete(callId);
    pending.resolve({
      status: isError ? "error" : "success",
      ...isError ? { error: result } : { result }
    });
  }
  // -------------------------------------------------------------------------
  // Request routing
  // -------------------------------------------------------------------------
  async handleRequest(req, res) {
    if (req.method === "GET" && req.url === "/health") {
      return this.handleHealth(res);
    }
    const authHeader = req.headers.authorization;
    const expected = `Bearer ${this.secret}`;
    if (!authHeader || authHeader.length !== expected.length || !(0, import_node_crypto.timingSafeEqual)(Buffer.from(authHeader), Buffer.from(expected))) {
      respond(res, 401, { error: "Unauthorized" });
      return;
    }
    if (req.method === "POST" && req.url === "/tool/pending") {
      return this.handleToolPending(req, res);
    }
    if (req.method === "POST" && req.url === "/tool/result") {
      return this.handleToolResult(req, res);
    }
    if (req.method === "POST" && req.url === "/tool/cancel") {
      return this.handleToolCancel(req, res);
    }
    respond(res, 404, { error: "Not found" });
  }
  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------
  handleHealth(res) {
    respond(res, 200, {
      status: "ok",
      uptime: Date.now() - this.startTime,
      pendingCalls: this.pendingCalls.size
    });
  }
  // -------------------------------------------------------------------------
  // POST /tool/pending — Hold-and-wait pattern
  // -------------------------------------------------------------------------
  async handleToolPending(req, res) {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch {
      respond(res, 400, {
        status: "error",
        error: "Invalid JSON in request body",
        code: "INVALID_REQUEST"
      });
      return;
    }
    if (!body.callId || !body.toolName) {
      respond(res, 400, {
        status: "error",
        error: "Missing required fields: callId and toolName",
        code: "INVALID_REQUEST"
      });
      return;
    }
    const { callId, toolName, args = {} } = body;
    if (this.pendingCalls.size >= MAX_PENDING_CALLS) {
      respond(res, 503, {
        status: "error",
        error: "Too many pending tool calls",
        code: "TOO_MANY_PENDING"
      });
      return;
    }
    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        resolve({
          status: "error",
          error: "Tool call timed out waiting for result from harness",
          code: "TOOL_TIMEOUT"
        });
      }, PENDING_CALL_TIMEOUT_MS);
      this.pendingCalls.set(callId, { resolve, reject, toolName, timer });
    });
    const pendingCall = { callId, toolName, args };
    this.laneRouter.route(pendingCall);
    const result = await resultPromise;
    respond(res, 200, result);
  }
  // -------------------------------------------------------------------------
  // POST /tool/result
  // -------------------------------------------------------------------------
  async handleToolResult(req, res) {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch {
      respond(res, 400, {
        status: "error",
        error: "Invalid JSON in request body",
        code: "INVALID_REQUEST"
      });
      return;
    }
    if (!body.callId) {
      respond(res, 400, {
        status: "error",
        error: "Missing required field: callId",
        code: "INVALID_REQUEST"
      });
      return;
    }
    const pending = this.pendingCalls.get(body.callId);
    if (!pending) {
      respond(res, 404, {
        status: "error",
        error: `No pending call: ${body.callId}`,
        code: "NOT_FOUND"
      });
      return;
    }
    clearTimeout(pending.timer);
    this.pendingCalls.delete(body.callId);
    pending.resolve({
      status: body.isError ? "error" : "success",
      ...body.isError ? { error: body.result } : { result: body.result }
    });
    respond(res, 200, { status: "ok" });
  }
  // -------------------------------------------------------------------------
  // POST /tool/cancel
  // -------------------------------------------------------------------------
  async handleToolCancel(req, res) {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch {
      respond(res, 400, { error: "Invalid JSON in request body" });
      return;
    }
    if (!body.callId) {
      respond(res, 400, { error: "Missing required field: callId" });
      return;
    }
    const pending = this.pendingCalls.get(body.callId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCalls.delete(body.callId);
      pending.resolve({
        status: "error",
        error: "Tool execution was cancelled",
        code: "TOOL_CANCELLED"
      });
      respond(res, 200, { status: "ok", cancelled: true });
    } else {
      respond(res, 200, { status: "ok", cancelled: false });
    }
  }
};
function createIPCServer(options = {}) {
  return new IPCServerImpl(options);
}

// src/kiro-auth.ts
var import_node_fs2 = require("fs");
var import_node_child_process = require("child_process");
var import_node_os = require("os");
var import_node_path2 = require("path");
function verifyAuth() {
  let installed = false;
  let version;
  try {
    version = (0, import_node_child_process.execFileSync)("kiro-cli", ["--version"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5e3
    }).toString().trim();
    installed = true;
  } catch {
    return { installed: false, authenticated: false };
  }
  let authenticated = false;
  try {
    const output = (0, import_node_child_process.execFileSync)("kiro-cli", ["whoami"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 1e4
    }).toString();
    authenticated = output.includes("Logged in");
  } catch {
  }
  const tokenPath = (0, import_node_path2.join)((0, import_node_os.homedir)(), ".aws", "sso", "cache", "kiro-auth-token.json");
  const hasToken = (0, import_node_fs2.existsSync)(tokenPath);
  return {
    installed,
    authenticated,
    version,
    tokenPath: hasToken ? tokenPath : void 0
  };
}

// src/acp-client.ts
var import_meta = {};
var KiroACPError = class extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
  code;
  data;
  name = "KiroACPError";
};
var KiroACPConnectionError = class extends Error {
  name = "KiroACPConnectionError";
  constructor(message) {
    super(message);
  }
};
var DEFAULT_REQUEST_TIMEOUT_MS = 3e5;
var INITIALIZE_TIMEOUT_MS = 3e4;
var STOP_TIMEOUT_MS = 1e4;
var ACPClient = class _ACPClient {
  options;
  process = null;
  readline = null;
  nextId = 0;
  pending = /* @__PURE__ */ new Map();
  metadata = /* @__PURE__ */ new Map();
  promptCallbacks = /* @__PURE__ */ new Map();
  running = false;
  stderrBuffer = "";
  toolsFilePath = null;
  ipcServer = null;
  ipcPort = null;
  availableTools = [];
  toolsReadyListeners = /* @__PURE__ */ new Set();
  /**
   * Per-instance unique ID for tools file isolation. Without this, concurrent
   * clients sharing the same cwd would clobber each other's tool definitions.
   */
  instanceId = (0, import_node_crypto2.randomBytes)(4).toString("hex");
  sessionToolsFiles = /* @__PURE__ */ new Set();
  /**
   * Mutex for serializing agent config rewrites + session creation.
   * Prevents race where model A rewrites config, model B overwrites it,
   * then model A creates a session reading model B's config.
   */
  sessionCreationLock = Promise.resolve();
  constructor(options) {
    this.options = options;
  }
  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  /**
   * Spawn kiro-cli acp and perform the initialize handshake.
   *
   * @param toolsFilePath - Optional path to a populated tools file. When
   *   provided, the agent config points to this file from the start so the
   *   MCP bridge sees the full tool set on its first query.
   */
  async start(toolsFilePath) {
    if (this.running) throw new KiroACPConnectionError("Client is already running");
    this.stderrBuffer = "";
    const authStatus = verifyAuth();
    if (!authStatus.installed) {
      throw new KiroACPConnectionError("`kiro-cli` is not installed or not available on PATH.");
    }
    if (!authStatus.authenticated) {
      throw new KiroACPConnectionError("`kiro-cli` is not authenticated. Run `kiro-cli login` and retry.");
    }
    const cwd = this.options.cwd;
    if (!(0, import_node_path3.isAbsolute)(cwd)) {
      throw new KiroACPError(`cwd must be absolute: ${cwd}`, -1);
    }
    if (!(0, import_node_fs3.existsSync)(cwd) || !(0, import_node_fs3.statSync)(cwd).isDirectory()) {
      throw new KiroACPError(`cwd is not a directory: ${cwd}`, -1);
    }
    this.ipcServer = createIPCServer();
    this.ipcPort = await this.ipcServer.start();
    if (this.options.agent) {
      this.setupAgentConfig(toolsFilePath);
    }
    try {
      (0, import_node_child_process2.execFileSync)("kiro-cli", ["settings", "mcp.noInteractiveTimeout", String(this.options.mcpTimeout ?? 30)], {
        timeout: 5e3,
        stdio: "ignore"
      });
    } catch {
    }
    const args = ["acp"];
    if (this.options.agent) {
      const sanitizedAgent = this.options.agent.replace(/[^a-zA-Z0-9_-]/g, "_");
      args.push("--agent", sanitizedAgent);
    }
    if (this.options.trustAllTools) args.push("--trust-all-tools");
    this.process = (0, import_node_child_process2.spawn)("kiro-cli", args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.options.env }
    });
    this.running = true;
    this.process.stderr?.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > 4096) {
        this.stderrBuffer = this.stderrBuffer.slice(-4096);
      }
    });
    this.process.on("exit", (code, signal) => {
      this.running = false;
      const rejectPending = () => {
        for (const [id, pending] of this.pending) {
          const detail = pending.method === "initialize" ? this.formatRecentStderr() : "";
          pending.reject(
            new KiroACPConnectionError(
              `Process exited (code=${code}, signal=${signal}) while waiting for ${pending.method}${detail}`
            )
          );
          clearTimeout(pending.timer ?? void 0);
          this.pending.delete(id);
        }
      };
      if (this.readline) {
        this.readline.once("close", rejectPending);
      } else {
        rejectPending();
      }
    });
    this.process.on("error", (err) => {
      this.running = false;
      for (const [id, pending] of this.pending) {
        const detail = pending.method === "initialize" ? this.formatRecentStderr() : "";
        pending.reject(new KiroACPConnectionError(`Process error: ${err.message}${detail}`));
        clearTimeout(pending.timer ?? void 0);
        this.pending.delete(id);
      }
    });
    this.readline = (0, import_node_readline.createInterface)({ input: this.process.stdout });
    this.readline.on("line", (line) => this.handleLine(line));
    const clientInfo = this.options.clientInfo ?? {
      name: "kiro-acp-ai-provider",
      version: "1.0.0",
      title: "Kiro ACP AI Provider"
    };
    const result = await this.sendRequest(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo
      },
      INITIALIZE_TIMEOUT_MS
    );
    const initResult = result;
    if (!initResult || typeof initResult !== "object" || !("agentInfo" in initResult)) {
      throw new KiroACPError("Invalid response from initialize: missing agentInfo", -1);
    }
    return initResult;
  }
  async stop() {
    if (!this.running || !this.process) return;
    this.running = false;
    this.process.stdin?.end();
    const proc = this.process;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve();
      }, STOP_TIMEOUT_MS);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.readline?.close();
    this.readline = null;
    this.process = null;
    for (const [id, pending] of this.pending) {
      pending.reject(new KiroACPConnectionError("Client stopped"));
      clearTimeout(pending.timer ?? void 0);
    }
    this.pending.clear();
    this.metadata.clear();
    this.promptCallbacks.clear();
    this.toolsReadyListeners.clear();
    this.availableTools = [];
    if (this.ipcServer) {
      await this.ipcServer.stop();
      this.ipcServer = null;
      this.ipcPort = null;
    }
    if (this.toolsFilePath) {
      try {
        (0, import_node_fs3.unlinkSync)(this.toolsFilePath);
      } catch {
      }
      this.toolsFilePath = null;
    }
    for (const filePath of this.sessionToolsFiles) {
      try {
        (0, import_node_fs3.unlinkSync)(filePath);
      } catch {
      }
    }
    this.sessionToolsFiles.clear();
  }
  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------
  async createSession() {
    return this.sendNewSession();
  }
  async sendNewSession() {
    const result = await this.sendRequest("session/new", {
      cwd: this.options.cwd,
      mcpServers: []
    });
    const session = result;
    if (!session || typeof session !== "object" || typeof session.sessionId !== "string") {
      throw new KiroACPError("Invalid response from session/new: missing sessionId", -1);
    }
    return session;
  }
  async loadSession(sessionId) {
    const result = await this.sendRequest("session/load", {
      sessionId,
      cwd: this.options.cwd,
      mcpServers: []
    });
    const session = result;
    if (!session || typeof session !== "object") {
      throw new KiroACPError("Invalid response from session/load: expected object", -1);
    }
    if (!session.sessionId) session.sessionId = sessionId;
    return session;
  }
  // -------------------------------------------------------------------------
  // Prompting
  // -------------------------------------------------------------------------
  async prompt(options) {
    const { sessionId, prompt, onUpdate, signal } = options;
    this.promptCallbacks.set(sessionId, onUpdate);
    let abortHandler;
    if (signal) {
      abortHandler = () => {
        this.sendNotification("session/cancel", { sessionId });
      };
      if (signal.aborted) {
        this.promptCallbacks.delete(sessionId);
        throw new KiroACPError("Prompt aborted before sending", -1);
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    try {
      const result = await this.sendRequest(
        "session/prompt",
        { sessionId, prompt },
        0
      );
      const promptResult = result;
      if (!promptResult || typeof promptResult !== "object" || typeof promptResult.stopReason !== "string") {
        throw new KiroACPError("Invalid response from session/prompt: missing stopReason", -1);
      }
      return promptResult;
    } finally {
      this.promptCallbacks.delete(sessionId);
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }
  // -------------------------------------------------------------------------
  // Model & mode switching
  // -------------------------------------------------------------------------
  async setModel(sessionId, modelId) {
    await this.executeCommand(sessionId, "model", { value: modelId });
  }
  async setMode(sessionId, modeId) {
    await this.sendRequest("session/set_mode", { sessionId, modeId });
  }
  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------
  async executeCommand(sessionId, command, args = {}) {
    const result = await this.sendRequest("_kiro.dev/commands/execute", {
      sessionId,
      command: { command, args }
    });
    const commandResult = result;
    if (!commandResult || typeof commandResult !== "object" || typeof commandResult.success !== "boolean") {
      throw new KiroACPError("Invalid response from commands/execute: missing success field", -1);
    }
    return commandResult;
  }
  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------
  getMetadata(sessionId) {
    return this.metadata.get(sessionId);
  }
  getAllMetadata() {
    return [...this.metadata.values()];
  }
  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------
  isRunning() {
    return this.running;
  }
  getStderr() {
    return this.stderrBuffer;
  }
  getCwd() {
    return this.options.cwd;
  }
  getAgentName() {
    return this.options.agent;
  }
  /** Return a copy of the construction options (for cloning). */
  getOptions() {
    return { ...this.options };
  }
  /**
   * Create a new ACPClient with the same options.
   * The returned client is NOT started — call `start()` separately.
   */
  clone() {
    return new _ACPClient(this.getOptions());
  }
  getAvailableTools() {
    return [...this.availableTools];
  }
  getToolsFilePath() {
    return this.toolsFilePath;
  }
  /**
   * Get or create the tools file path for this client instance.
   * Path: `{tmpdir}/kiro-acp/tools-{cwdHash}-{instanceId}.json`
   */
  getOrCreateToolsFilePath() {
    if (this.toolsFilePath) return this.toolsFilePath;
    const toolsDir = (0, import_node_path3.join)((0, import_node_os2.tmpdir)(), "kiro-acp");
    (0, import_node_fs3.mkdirSync)(toolsDir, { recursive: true, mode: 448 });
    (0, import_node_fs3.chmodSync)(toolsDir, 448);
    const cwdHash = (0, import_node_crypto2.createHash)("md5").update(this.options.cwd).digest("hex").slice(0, 8);
    this.toolsFilePath = (0, import_node_path3.join)(toolsDir, `tools-${cwdHash}-${this.instanceId}.json`);
    return this.toolsFilePath;
  }
  /**
   * Create a unique tools file path for a specific ACP session.
   * Path: `{tmpdir}/kiro-acp/tools-{cwdHash}-{sessionUniqueId}.json`
   */
  createSessionToolsFilePath(sessionUniqueId) {
    const toolsDir = (0, import_node_path3.join)((0, import_node_os2.tmpdir)(), "kiro-acp");
    (0, import_node_fs3.mkdirSync)(toolsDir, { recursive: true, mode: 448 });
    (0, import_node_fs3.chmodSync)(toolsDir, 448);
    const cwdHash = (0, import_node_crypto2.createHash)("md5").update(this.options.cwd).digest("hex").slice(0, 8);
    const filePath = (0, import_node_path3.join)(toolsDir, `tools-${cwdHash}-${sessionUniqueId}.json`);
    this.sessionToolsFiles.add(filePath);
    return filePath;
  }
  removeSessionToolsFile(filePath) {
    this.sessionToolsFiles.delete(filePath);
    try {
      (0, import_node_fs3.unlinkSync)(filePath);
    } catch {
    }
  }
  /**
   * Atomically rewrite the agent config to point to a different tools file,
   * then create a new session. Protected by a mutex to prevent concurrent
   * model instances from interfering.
   */
  async createSessionWithToolsPath(toolsFilePath) {
    const previousLock = this.sessionCreationLock;
    let releaseLock;
    this.sessionCreationLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    try {
      await previousLock;
      if (this.options.agent) {
        const bridgePath = this.resolveBridgePath();
        const config = generateAgentConfig({
          name: this.options.agent,
          mcpBridgePath: bridgePath,
          toolsFilePath,
          cwd: this.options.cwd,
          prompt: this.options.agentPrompt
        });
        writeAgentConfig(this.options.cwd, this.options.agent, config);
      }
      return await this.sendNewSession();
    } finally {
      releaseLock();
    }
  }
  getIpcPort() {
    return this.ipcPort;
  }
  getIpcSecret() {
    return this.ipcServer?.getSecret() ?? null;
  }
  getIPCServer() {
    return this.ipcServer;
  }
  getLaneRouter() {
    return this.ipcServer?.getLaneRouter() ?? null;
  }
  /** Replace the prompt callback for a session (used during resumption). */
  setPromptCallback(sessionId, callback) {
    this.promptCallbacks.set(sessionId, callback);
  }
  /**
   * Wait for kiro-cli to send `_kiro.dev/commands/available`.
   * Fires after mode switches and tool list updates.
   *
   * If `expectedTools` is provided, waits until all are present.
   * Resolves with current tools on timeout.
   */
  waitForToolsReady(options) {
    const { timeoutMs = 5e3, expectedTools } = options ?? {};
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeToolsReadyListener(handler);
        resolve(this.availableTools);
      }, timeoutMs);
      const handler = (tools) => {
        if (!expectedTools) {
          clearTimeout(timer);
          this.removeToolsReadyListener(handler);
          resolve(tools);
          return;
        }
        const names = new Set(tools.map((t) => t.name));
        const allPresent = expectedTools.every((name) => names.has(name));
        if (allPresent) {
          clearTimeout(timer);
          this.removeToolsReadyListener(handler);
          resolve(tools);
        }
      };
      this.addToolsReadyListener(handler);
    });
  }
  addToolsReadyListener(listener) {
    this.toolsReadyListeners.add(listener);
  }
  removeToolsReadyListener(listener) {
    this.toolsReadyListeners.delete(listener);
  }
  // -------------------------------------------------------------------------
  // Internal: Agent config setup
  // -------------------------------------------------------------------------
  /**
   * Generate and write the agent config file.
   *
   * When a populated tools file path is provided, the config points directly
   * to it. Otherwise creates a placeholder (safe because createSessionWithToolsPath
   * rewrites the config before any session is created).
   */
  setupAgentConfig(populatedToolsFilePath) {
    const bridgePath = this.resolveBridgePath();
    let toolsFile;
    if (populatedToolsFilePath) {
      toolsFile = populatedToolsFilePath;
      if (this.ipcPort != null) {
        try {
          const existing = (0, import_node_fs3.readFileSync)(toolsFile, "utf-8");
          const parsed = JSON.parse(existing);
          const secret = this.ipcServer?.getSecret();
          if (parsed.ipcPort !== this.ipcPort || secret && parsed.ipcSecret !== secret) {
            ;
            parsed.ipcPort = this.ipcPort;
            if (secret) parsed.ipcSecret = secret;
            const tmpPath = toolsFile + ".tmp";
            (0, import_node_fs3.writeFileSync)(tmpPath, JSON.stringify(parsed, null, 2), { mode: 384 });
            (0, import_node_fs3.renameSync)(tmpPath, toolsFile);
          }
        } catch {
        }
      }
    } else {
      toolsFile = this.getOrCreateToolsFilePath();
      const secret = this.ipcServer?.getSecret();
      const toolsData = {
        tools: [],
        cwd: this.options.cwd,
        ...this.ipcPort != null ? { ipcPort: this.ipcPort } : {},
        ...secret ? { ipcSecret: secret } : {}
      };
      const tmpPath = toolsFile + ".tmp";
      (0, import_node_fs3.writeFileSync)(tmpPath, JSON.stringify(toolsData, null, 2), { mode: 384 });
      (0, import_node_fs3.renameSync)(tmpPath, toolsFile);
    }
    const config = generateAgentConfig({
      name: this.options.agent,
      mcpBridgePath: bridgePath,
      toolsFilePath: toolsFile,
      cwd: this.options.cwd,
      prompt: this.options.agentPrompt
    });
    writeAgentConfig(this.options.cwd, this.options.agent, config);
  }
  /**
   * Resolve the MCP bridge script to a real filesystem path.
   *
   * Handles: dev symlinks, npm/bun installs, Bun-compiled binaries
   * (virtual /$bunfs paths), .bun cache, and ancestor node_modules.
   */
  resolveBridgePath() {
    try {
      if (typeof import_meta?.url === "string" && import_meta.url) {
        const currentDir = (0, import_node_path3.dirname)((0, import_node_url.fileURLToPath)(import_meta.url));
        const directPath = (0, import_node_path3.join)(currentDir, "mcp-bridge.js");
        if (!directPath.includes("$bunfs") && (0, import_node_fs3.existsSync)(directPath)) {
          return directPath;
        }
      }
    } catch {
    }
    const nmBase = (0, import_node_path3.join)(this.options.cwd, "node_modules");
    const directNm = (0, import_node_path3.join)(nmBase, "kiro-acp-ai-provider", "dist", "mcp-bridge.js");
    if ((0, import_node_fs3.existsSync)(directNm)) return directNm;
    const bunDir = (0, import_node_path3.join)(nmBase, ".bun");
    if ((0, import_node_fs3.existsSync)(bunDir)) {
      try {
        const entries = (0, import_node_fs3.readdirSync)(bunDir);
        for (const entry of entries) {
          if (entry.includes("kiro-acp-ai-provider")) {
            const cached = (0, import_node_path3.join)(
              bunDir,
              entry,
              "node_modules",
              "kiro-acp-ai-provider",
              "dist",
              "mcp-bridge.js"
            );
            if ((0, import_node_fs3.existsSync)(cached)) return cached;
          }
        }
      } catch {
      }
    }
    let searchDir = this.options.cwd;
    for (let i = 0; i < 10; i++) {
      const candidate = (0, import_node_path3.join)(searchDir, "node_modules", "kiro-acp-ai-provider", "dist", "mcp-bridge.js");
      if ((0, import_node_fs3.existsSync)(candidate)) return candidate;
      const ancestorBunDir = (0, import_node_path3.join)(searchDir, "node_modules", ".bun");
      if ((0, import_node_fs3.existsSync)(ancestorBunDir)) {
        try {
          for (const entry of (0, import_node_fs3.readdirSync)(ancestorBunDir)) {
            if (entry.includes("kiro-acp-ai-provider")) {
              const cached = (0, import_node_path3.join)(
                ancestorBunDir,
                entry,
                "node_modules",
                "kiro-acp-ai-provider",
                "dist",
                "mcp-bridge.js"
              );
              if ((0, import_node_fs3.existsSync)(cached)) return cached;
            }
          }
        } catch {
        }
      }
      const parent = (0, import_node_path3.dirname)(searchDir);
      if (parent === searchDir) break;
      searchDir = parent;
    }
    const binDir = (0, import_node_path3.dirname)(process.argv[0] || "");
    if (binDir) {
      let dir = binDir;
      for (let i = 0; i < 10; i++) {
        const candidate = (0, import_node_path3.join)(dir, "node_modules", "kiro-acp-ai-provider", "dist", "mcp-bridge.js");
        if ((0, import_node_fs3.existsSync)(candidate)) return candidate;
        const binBunDir = (0, import_node_path3.join)(dir, "node_modules", ".bun");
        if ((0, import_node_fs3.existsSync)(binBunDir)) {
          try {
            for (const entry of (0, import_node_fs3.readdirSync)(binBunDir)) {
              if (entry.includes("kiro-acp-ai-provider")) {
                const cached = (0, import_node_path3.join)(
                  binBunDir,
                  entry,
                  "node_modules",
                  "kiro-acp-ai-provider",
                  "dist",
                  "mcp-bridge.js"
                );
                if ((0, import_node_fs3.existsSync)(cached)) return cached;
              }
            }
          } catch {
          }
        }
        const parent = (0, import_node_path3.dirname)(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    const execDir = (0, import_node_path3.dirname)(process.execPath || "");
    if (execDir && execDir !== ".") {
      let dir = execDir;
      for (let i = 0; i < 10; i++) {
        const candidate = (0, import_node_path3.join)(dir, "node_modules", "kiro-acp-ai-provider", "dist", "mcp-bridge.js");
        if ((0, import_node_fs3.existsSync)(candidate)) return candidate;
        const parent = (0, import_node_path3.dirname)(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    throw new KiroACPConnectionError(
      "Could not find mcp-bridge.js. Ensure kiro-acp-ai-provider is installed."
    );
  }
  // -------------------------------------------------------------------------
  // Internal: JSON-RPC transport
  // -------------------------------------------------------------------------
  sendRequest(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.running || !this.process?.stdin?.writable) {
        reject(new KiroACPConnectionError("Client is not running"));
        return;
      }
      const id = this.nextId++;
      const request = { jsonrpc: "2.0", id, method, params };
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        if (method === "session/prompt") {
          const sid = params?.sessionId;
          if (sid) {
            this.sendNotification("session/cancel", { sessionId: sid });
          }
        }
        reject(this.createTimeoutError(method, timeoutMs));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, method, timer });
      const line = JSON.stringify(request) + "\n";
      this.process.stdin.write(line);
    });
  }
  createTimeoutError(method, timeoutMs) {
    const parts = [`Request timed out after ${timeoutMs}ms: ${method}`];
    if (method === "initialize") {
      const detail = this.formatRecentStderr();
      if (detail) {
        parts.push(detail.trimStart());
      }
    }
    return new KiroACPError(parts.join("\n\n"), -1);
  }
  formatRecentStderr() {
    const stderr = this.stderrBuffer.trim();
    return stderr ? `

kiro-cli stderr:
${stderr}` : "";
  }
  sendNotification(method, params) {
    if (!this.running || !this.process?.stdin?.writable) return;
    const notification = { jsonrpc: "2.0", method, params };
    const line = JSON.stringify(notification) + "\n";
    this.process.stdin.write(line);
  }
  sendResponse(id, result) {
    if (!this.running || !this.process?.stdin?.writable) return;
    const response = { jsonrpc: "2.0", id, result };
    const line = JSON.stringify(response) + "\n";
    this.process.stdin.write(line);
  }
  // -------------------------------------------------------------------------
  // Internal: message dispatch
  // -------------------------------------------------------------------------
  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const hasId = "id" in msg && msg.id !== void 0;
    const hasMethod = "method" in msg && typeof msg.method === "string";
    if (hasId && !hasMethod) {
      this.handleResponse(msg);
    } else if (hasId && hasMethod) {
      this.handleServerRequest(msg);
    } else if (hasMethod) {
      this.handleNotification(msg);
    }
  }
  handleResponse(msg) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer ?? void 0);
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new KiroACPError(msg.error.message, msg.error.code, msg.error.data));
    } else {
      pending.resolve(msg.result);
    }
  }
  handleServerRequest(msg) {
    switch (msg.method) {
      case "session/request_permission":
        this.handlePermissionRequest(msg.id, msg.params);
        break;
      default:
        this.sendResponse(msg.id, null);
        break;
    }
  }
  handlePermissionRequest(id, request) {
    if (this.options.onPermission) {
      const decision = this.options.onPermission(request);
      this.sendResponse(id, decision);
    } else {
      const alwaysOption = request.options.find((o) => o.id === "allow_always");
      const onceOption = request.options.find((o) => o.id === "allow_once");
      const optionId = alwaysOption?.id ?? onceOption?.id ?? request.options[0]?.id ?? "allow_once";
      this.sendResponse(id, {
        outcome: { outcome: "selected", optionId }
      });
    }
  }
  handleNotification(msg) {
    const params = msg.params ?? {};
    switch (msg.method) {
      case "session/update":
        this.handleSessionUpdate(params);
        break;
      case "_kiro.dev/metadata":
        this.handleMetadata(params);
        break;
      case "_kiro.dev/session/update":
        this.handleSessionUpdate(params);
        break;
      case "_kiro.dev/commands/available": {
        const tools = Array.isArray(params.tools) ? params.tools : [];
        this.availableTools = tools;
        for (const listener of this.toolsReadyListeners) {
          listener(tools);
        }
        break;
      }
      default:
        this.options.onExtension?.(msg.method, params);
        break;
    }
  }
  handleSessionUpdate(params) {
    const sessionId = params.sessionId;
    const update = params.update;
    if (!update) return;
    if (sessionId) {
      const callback = this.promptCallbacks.get(sessionId);
      callback?.(update);
    }
    if (sessionId) {
      this.options.onUpdate?.(sessionId, update);
    }
  }
  handleMetadata(params) {
    const sessionId = params.sessionId;
    if (!sessionId) return;
    this.metadata.set(sessionId, {
      sessionId,
      contextUsagePercentage: params.contextUsagePercentage,
      meteringUsage: params.meteringUsage,
      turnDurationMs: params.turnDurationMs
    });
  }
};

// src/kiro-acp-model.ts
var import_node_fs5 = require("fs");
var import_node_crypto4 = require("crypto");

// src/session-storage.ts
var import_node_fs4 = require("fs");
var import_node_crypto3 = require("crypto");
var import_node_path4 = require("path");
var import_node_os3 = require("os");
function getXdgDataHome() {
  return process.env.XDG_DATA_HOME || (0, import_node_path4.join)((0, import_node_os3.homedir)(), ".local", "share");
}
var APP_DIR = "kiro-acp-ai-provider";
var SESSION_TTL_MS = 24 * 60 * 60 * 1e3;
function getSessionDir(cwd) {
  const cwdHash = (0, import_node_crypto3.createHash)("md5").update(cwd).digest("hex").slice(0, 8);
  return (0, import_node_path4.join)(getXdgDataHome(), APP_DIR, "sessions", cwdHash);
}
function getSessionFilePath(cwd, affinityId) {
  const sanitized = affinityId ? affinityId.replace(/[^a-zA-Z0-9_-]/g, "_") : void 0;
  const fileName = sanitized ? `${sanitized}.json` : "_default.json";
  return (0, import_node_path4.join)(getSessionDir(cwd), fileName);
}
function persistSession(cwd, sessionId, affinityId) {
  try {
    const filePath = getSessionFilePath(cwd, affinityId);
    const dir = (0, import_node_path4.join)(filePath, "..");
    (0, import_node_fs4.mkdirSync)(dir, { recursive: true, mode: 448 });
    const data = {
      kiroSessionId: sessionId,
      lastUsed: Date.now()
    };
    const tmpPath = filePath + ".tmp";
    (0, import_node_fs4.writeFileSync)(tmpPath, JSON.stringify(data), { mode: 384 });
    (0, import_node_fs4.renameSync)(tmpPath, filePath);
  } catch {
  }
}
function clearPersistedSession(cwd, affinityId) {
  const filePath = getSessionFilePath(cwd, affinityId);
  try {
    (0, import_node_fs4.unlinkSync)(filePath);
  } catch {
  }
}
function loadPersistedSession(cwd, affinityId) {
  try {
    const filePath = getSessionFilePath(cwd, affinityId);
    const raw = (0, import_node_fs4.readFileSync)(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (Date.now() - data.lastUsed > SESSION_TTL_MS) return null;
    if (!data.kiroSessionId || typeof data.kiroSessionId !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

// src/kiro-acp-model.ts
function parseToolCallNotification(update) {
  const toolCallId = update.toolCallId;
  const rawInput = update.rawInput;
  let toolName;
  const title = update.title;
  if (title) {
    const match = title.match(/\/([^/]+)$/);
    if (match) {
      toolName = match[1];
    }
  }
  const args = {};
  if (rawInput) {
    for (const [key, value] of Object.entries(rawInput)) {
      if (!key.startsWith("__")) {
        args[key] = value;
      }
    }
  }
  return { toolCallId, toolName, args };
}
function emptyUsage() {
  return {
    inputTokens: {
      total: void 0,
      noCache: void 0,
      cacheRead: void 0,
      cacheWrite: void 0
    },
    outputTokens: {
      total: void 0,
      text: void 0,
      reasoning: void 0
    }
  };
}
function estimateUsage(outputCharCount, contextPercentage, contextWindow) {
  const output = Math.round(outputCharCount / 4);
  const total = contextPercentage != null ? Math.round(contextPercentage / 100 * contextWindow) : void 0;
  const input = total != null ? Math.max(0, total - output) : void 0;
  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: void 0,
      cacheWrite: void 0
    },
    outputTokens: {
      total: output > 0 ? output : void 0,
      text: output > 0 ? output : void 0,
      reasoning: void 0
    }
  };
}
function mapStopReason(stopReason) {
  switch (stopReason) {
    case "end_turn":
      return { unified: "stop", raw: stopReason };
    case "max_tokens":
      return { unified: "length", raw: stopReason };
    case "tool_use":
      return { unified: "tool-calls", raw: stopReason };
    case "cancelled":
      return { unified: "error", raw: "cancelled" };
    case "content_filter":
      return { unified: "content-filter", raw: stopReason };
    default:
      return { unified: "other", raw: stopReason };
  }
}
function extractPrompt(prompt) {
  const systemParts = [];
  let lastUserMessage = "";
  for (const message of prompt) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else if (message.role === "user") {
      const parts = [];
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push(part.text);
        }
      }
      lastUserMessage = parts.join("\n");
    }
  }
  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : void 0;
  return {
    systemPrompt,
    userMessage: lastUserMessage
  };
}
function formatConversationReplay(prompt) {
  const systemParts = [];
  const historyParts = [];
  let lastUserMessage = "";
  for (const message of prompt) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === "user") {
      if (lastUserMessage) {
        historyParts.push(`User: ${lastUserMessage}`);
      }
      const parts = [];
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push(part.text);
        }
      }
      lastUserMessage = parts.join("\n");
      continue;
    }
    if (message.role === "assistant") {
      const parts = [];
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push(part.text);
        }
      }
      if (parts.length > 0) {
        historyParts.push(`Assistant: ${parts.join("\n")}`);
      }
      continue;
    }
    if (message.role === "tool") {
      continue;
    }
  }
  const sections = [];
  if (systemParts.length > 0) {
    sections.push(`<system_instructions>
${systemParts.join("\n\n")}
</system_instructions>`);
  }
  if (historyParts.length > 0) {
    sections.push(`<context>
${historyParts.join("\n\n")}
</context>`);
  }
  sections.push(`Resume and act on the following message.

${lastUserMessage}`);
  return sections.join("\n\n");
}
var TOOL_CALL_DEBOUNCE_MS = 100;
var KiroACPLanguageModel = class _KiroACPLanguageModel {
  specificationVersion = "v3";
  provider = "kiro-acp";
  modelId;
  defaultObjectGenerationMode = void 0;
  supportedUrls = {};
  client;
  config;
  currentModelId = null;
  initPromise = null;
  totalCredits = 0;
  currentAffinityId;
  /**
   * Per-session tools file paths. Each ACP session gets its own file
   * so concurrent sessions don't overwrite each other's tool definitions.
   */
  sessionToolsFiles = /* @__PURE__ */ new Map();
  /**
   * Per-session state for prompts paused waiting for tool results.
   * When a tool call arrives via IPC, we close the stream and store state here.
   * The next doStream() (with tool results) uses this to resume.
   */
  pendingTurns = /* @__PURE__ */ new Map();
  /**
   * Isolated ACP clients for subagent sessions (separate kiro-cli processes).
   * Each subagent gets its own process to prevent tool leakage between parent
   * and child sessions that would otherwise share the same kiro-cli process.
   */
  subClients = /* @__PURE__ */ new Map();
  constructor(modelId, config) {
    this.modelId = modelId;
    this.client = config.client;
    this.config = config;
  }
  // -------------------------------------------------------------------------
  // Credits tracking
  // -------------------------------------------------------------------------
  getTotalCredits() {
    return this.totalCredits;
  }
  // -------------------------------------------------------------------------
  // Session creation — one session per doStream() lifecycle
  // -------------------------------------------------------------------------
  /**
   * Ensure the ACP client is started. Safe to call multiple times.
   * If initialization fails, subsequent calls will retry.
   */
  async ensureClient(toolsFilePath) {
    if (this.client.isRunning()) return;
    if (this.initPromise) {
      await this.initPromise;
      if (this.client.isRunning()) return;
      this.initPromise = null;
    }
    this.initPromise = this.client.start(toolsFilePath).then(() => {
    });
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }
  /**
   * Create a new ACP session for this doStream() call.
   *
   * Each doStream() gets a fresh session with its own tools file.
   * With affinity, tries to resume a persisted session first.
   * Without affinity (subagent calls), always creates fresh.
   */
  async acquireSession(tools) {
    let toolsFilePath;
    let toolNames = "";
    if (tools && tools.length > 0) {
      const streamId = (0, import_node_crypto4.randomBytes)(4).toString("hex");
      toolsFilePath = this.client.createSessionToolsFilePath(streamId);
      toolNames = this.writeToolsToFile(toolsFilePath, tools);
    }
    await this.ensureClient(toolsFilePath);
    if (toolsFilePath && this.client.getIpcPort() != null) {
      this.ensureIpcPortInToolsFile(toolsFilePath);
    }
    if (this.currentAffinityId) {
      if (this.config.sessionId) {
        try {
          const loaded = await this.client.loadSession(this.config.sessionId);
          const sessionId = loaded.sessionId || this.config.sessionId;
          if (!loaded.sessionId) loaded.sessionId = sessionId;
          await this.ensureSessionMode(loaded);
          if (this.currentModelId === null) {
            this.currentModelId = loaded.models.currentModelId;
          }
          if (toolsFilePath) {
            this.sessionToolsFiles.set(sessionId, { filePath: toolsFilePath, toolNames });
          }
          persistSession(this.client.getCwd(), sessionId, this.currentAffinityId);
          return loaded;
        } catch (err) {
        }
      }
      const persisted = loadPersistedSession(this.client.getCwd(), this.currentAffinityId);
      if (persisted) {
        try {
          const session2 = await this.client.loadSession(persisted.kiroSessionId);
          const sessionId = session2.sessionId || persisted.kiroSessionId;
          if (!session2.sessionId) session2.sessionId = sessionId;
          if (session2) {
            await this.ensureSessionMode(session2);
            if (this.currentModelId === null) {
              this.currentModelId = session2.models?.currentModelId ?? null;
            }
            if (toolsFilePath) {
              this.sessionToolsFiles.set(sessionId, { filePath: toolsFilePath, toolNames });
            }
            persistSession(this.client.getCwd(), sessionId, this.currentAffinityId);
            return session2;
          }
        } catch (err) {
        }
      }
    }
    const session = toolsFilePath ? await this.client.createSessionWithToolsPath(toolsFilePath) : await this.client.createSession();
    await this.ensureSessionMode(session);
    if (this.currentModelId === null) {
      this.currentModelId = session.models.currentModelId;
    }
    if (toolsFilePath) {
      this.sessionToolsFiles.set(session.sessionId, { filePath: toolsFilePath, toolNames });
    }
    if (this.currentAffinityId) {
      persistSession(this.client.getCwd(), session.sessionId, this.currentAffinityId);
    }
    return session;
  }
  /**
   * Clean up after a doStream() lifecycle completes.
   *
   * With affinity: persist mapping, keep kiro session alive, remove tools file.
   * Without affinity: full cleanup (one-shot session).
   */
  cleanupAfterStream(sessionId) {
    if (this.currentAffinityId) {
      persistSession(this.client.getCwd(), sessionId, this.currentAffinityId);
    } else {
      this.cleanupSessionToolsFile(sessionId);
    }
  }
  /**
   * Ensure a session uses the correct agent mode.
   *
   * Only the first session inherits the `--agent` flag's mode.
   * Subsequent sessions default to `kiro_default`, so we explicitly
   * set the mode after creation/loading.
   */
  async ensureSessionMode(session) {
    const agentName = this.client.getAgentName();
    if (!agentName) return;
    if (session.modes.currentModeId !== agentName) {
      await this.client.setMode(session.sessionId, agentName);
      session.modes.currentModeId = agentName;
      await this.client.waitForToolsReady({ timeoutMs: 5e3 });
    }
  }
  /** Switch model on a session if the requested modelId differs. */
  async ensureModel(session) {
    if (this.currentModelId === this.modelId) return;
    await this.client.setModel(session.sessionId, this.modelId);
    this.currentModelId = this.modelId;
  }
  // -------------------------------------------------------------------------
  // Session persistence
  // -------------------------------------------------------------------------
  setAffinityId(affinityId) {
    this.currentAffinityId = affinityId;
  }
  // -------------------------------------------------------------------------
  // Session rehydration
  // -------------------------------------------------------------------------
  getSessionId() {
    const firstPending = this.pendingTurns.keys().next();
    return firstPending.done ? null : firstPending.value;
  }
  /**
   * Inject conversation context into a new session.
   * Used when session/load fails and we need to rehydrate from the consumer's history.
   */
  async injectContext(summary) {
    const session = await this.acquireSession();
    try {
      await this.client.prompt({
        sessionId: session.sessionId,
        prompt: [{
          type: "text",
          text: `<context_rehydration>
The following is a summary of our previous conversation that was interrupted:

${summary}

Please acknowledge this context and continue from where we left off.
</context_rehydration>`
        }],
        onUpdate: () => {
        }
      });
    } finally {
      this.cleanupAfterStream(session.sessionId);
    }
  }
  // -------------------------------------------------------------------------
  // Dynamic tool synchronization — per-session tools files
  // -------------------------------------------------------------------------
  /**
   * Write tool definitions to a tools file in MCP format.
   * Only function tools are synced — provider tools are handled by the provider itself.
   * @returns Sorted tool names string (for change detection).
   */
  writeToolsToFile(toolsFilePath, tools) {
    const newTools = tools.filter((tool) => tool.type === "function").map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema
    }));
    const toolNames = newTools.map((t) => t.name).sort().join(",");
    const ipcPort = this.client.getIpcPort();
    const ipcSecret = this.client.getIpcSecret();
    const toolsData = {
      tools: newTools,
      cwd: this.client.getCwd(),
      ...ipcPort != null ? { ipcPort } : {},
      ...ipcSecret ? { ipcSecret } : {}
    };
    const tmpPath = toolsFilePath + ".tmp";
    (0, import_node_fs5.writeFileSync)(tmpPath, JSON.stringify(toolsData, null, 2), { mode: 384 });
    (0, import_node_fs5.renameSync)(tmpPath, toolsFilePath);
    return toolNames;
  }
  /**
   * Inject IPC port into a tools file if missing.
   * Needed when tools are written before ensureClient() starts the IPC server.
   */
  ensureIpcPortInToolsFile(toolsFilePath) {
    const ipcPort = this.client.getIpcPort();
    if (ipcPort == null) return;
    try {
      const raw = (0, import_node_fs5.readFileSync)(toolsFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      const ipcSecret = this.client.getIpcSecret();
      if (parsed.ipcPort === ipcPort && parsed.ipcSecret === ipcSecret) return;
      parsed.ipcPort = ipcPort;
      if (ipcSecret) parsed.ipcSecret = ipcSecret;
      const tmpPath = toolsFilePath + ".tmp";
      (0, import_node_fs5.writeFileSync)(tmpPath, JSON.stringify(parsed, null, 2), { mode: 384 });
      (0, import_node_fs5.renameSync)(tmpPath, toolsFilePath);
    } catch {
    }
  }
  cleanupSessionToolsFile(sessionId) {
    const entry = this.sessionToolsFiles.get(sessionId);
    if (!entry) return;
    this.sessionToolsFiles.delete(sessionId);
    this.client.removeSessionToolsFile(entry.filePath);
  }
  // -------------------------------------------------------------------------
  // Tool result extraction from AI SDK prompt
  // -------------------------------------------------------------------------
  /**
   * Extract tool results from `role: "tool"` messages in the prompt.
   */
  extractToolResults(prompt) {
    const results = [];
    for (const message of prompt) {
      if (message.role === "tool") {
        for (const part of message.content) {
          if (part.type === "tool-result") {
            const output = part.output;
            const resultText = output.type === "text" ? output.value : JSON.stringify(output);
            results.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result: resultText
            });
          }
        }
      }
    }
    return results;
  }
  // -------------------------------------------------------------------------
  // LanguageModelV3 — doStream
  // -------------------------------------------------------------------------
  async doStream(options) {
    const affinityId = typeof options.headers?.["x-session-affinity"] === "string" ? options.headers["x-session-affinity"] : void 0;
    this.setAffinityId(affinityId);
    const isChild = typeof options.headers?.["x-parent-session-id"] === "string";
    const hasTools = (options.tools ?? []).length > 0;
    if (isChild && hasTools && affinityId) {
      return this.doStreamIsolated(options, affinityId);
    }
    const reset = options.headers?.["x-session-reset"] === "true";
    if (reset && affinityId) {
      clearPersistedSession(this.client.getCwd(), affinityId);
    }
    const toolResults = this.extractToolResults(options.prompt);
    if (toolResults.length > 0) {
      const pendingEntry = this.findPendingTurnForResults(toolResults);
      if (pendingEntry) {
        return this.resumeWithToolResults(pendingEntry.sessionId, toolResults, options);
      }
    }
    return this.startFreshPrompt(options, reset);
  }
  // -------------------------------------------------------------------------
  // Subagent isolation — separate kiro-cli process per subagent
  // -------------------------------------------------------------------------
  static SUB_CLIENT_IDLE_MS = 18e4;
  /**
   * Route a subagent doStream() call to an isolated KiroACPLanguageModel
   * backed by its own ACPClient (separate kiro-cli process).
   *
   * The isolated client is reused across turns for the same affinityId
   * (tool call → tool result → continuation) and cleaned up after 60s idle.
   */
  async doStreamIsolated(options, affinityId) {
    let entry = this.subClients.get(affinityId);
    if (!entry) {
      const client = this.client.clone();
      const model = new _KiroACPLanguageModel(this.modelId, {
        client,
        contextWindow: this.config.contextWindow
      });
      entry = { client, model, timer: null };
      this.subClients.set(affinityId, entry);
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const isolatedOptions = {
      ...options,
      headers: {
        ...options.headers,
        "x-parent-session-id": void 0
      }
    };
    const result = await entry.model.doStream(isolatedOptions);
    const capturedEntry = entry;
    const capturedId = affinityId;
    capturedEntry.timer = setTimeout(() => {
      void capturedEntry.client.stop();
      this.subClients.delete(capturedId);
    }, _KiroACPLanguageModel.SUB_CLIENT_IDLE_MS);
    return result;
  }
  /**
   * Shutdown all isolated subagent clients.
   * Call this when the parent provider is shutting down.
   */
  async shutdownSubClients() {
    for (const [id, entry] of this.subClients) {
      if (entry.timer) clearTimeout(entry.timer);
      await entry.client.stop();
    }
    this.subClients.clear();
  }
  // -------------------------------------------------------------------------
  // Pending turn lookup
  // -------------------------------------------------------------------------
  /** Find the pending turn whose tool call IDs match the given tool results. */
  findPendingTurnForResults(toolResults) {
    for (const [sessionId, state] of this.pendingTurns) {
      const pendingCallIds = new Set(state.pendingToolCalls.keys());
      const hasMatch = toolResults.some((r) => pendingCallIds.has(r.toolCallId));
      if (hasMatch) return { sessionId, state };
    }
    return null;
  }
  // -------------------------------------------------------------------------
  // Shared stream infrastructure for prompt flows
  // -------------------------------------------------------------------------
  /**
   * Create the stream infrastructure shared by both fresh prompts and
   * tool-result resumptions.
   *
   * Returns the readable stream, an update handler for ACP notifications,
   * and completion/error handlers that wire up the prompt promise to the
   * stream lifecycle.
   */
  createPromptStream(params) {
    const {
      sessionId,
      promptAbort,
      initialOutputCharCount,
      streamSegment,
      options,
      savePendingTurn
    } = params;
    let textStarted = false;
    let reasoningStarted = false;
    let outputCharCount = initialOutputCharCount;
    let streamClosed = false;
    const textId = `txt-${streamSegment}`;
    const reasoningId = `reasoning-${streamSegment}`;
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    let writeChain = Promise.resolve();
    const writePart = (part) => {
      if (streamClosed) return;
      writeChain = writeChain.then(() => writer.write(part)).catch(() => {
        streamClosed = true;
      });
    };
    let bufferedToolCalls = [];
    let debounceTimer = null;
    let userAbortHandler;
    if (options.abortSignal) {
      userAbortHandler = () => promptAbort.abort();
      options.abortSignal.addEventListener("abort", userAbortHandler, { once: true });
    }
    const removeAbortListener = () => {
      if (options.abortSignal && userAbortHandler) {
        options.abortSignal.removeEventListener("abort", userAbortHandler);
      }
    };
    const laneRouter = this.client.getLaneRouter();
    const flushToolCalls = async () => {
      if (streamClosed || bufferedToolCalls.length === 0) return;
      if (reasoningStarted) {
        reasoningStarted = false;
        writePart({ type: "reasoning-end", id: reasoningId });
      }
      if (textStarted) {
        textStarted = false;
        writePart({ type: "text-end", id: textId });
      }
      for (const call of bufferedToolCalls) {
        const argsJson = JSON.stringify(call.args);
        writePart({ type: "tool-input-start", id: call.callId, toolName: call.toolName });
        writePart({ type: "tool-input-delta", id: call.callId, delta: argsJson });
        writePart({ type: "tool-input-end", id: call.callId });
        writePart({
          type: "tool-call",
          toolCallId: call.callId,
          toolName: call.toolName,
          input: argsJson
        });
      }
      savePendingTurn({
        pendingToolCalls: new Map(bufferedToolCalls.map((c) => [c.callId, c])),
        outputCharCount,
        nextSegment: streamSegment + 1
      });
      const metadata = this.client.getMetadata(sessionId);
      writePart({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: estimateUsage(outputCharCount, metadata?.contextUsagePercentage, this.config.contextWindow ?? 1e6)
      });
      removeAbortListener();
      streamClosed = true;
      bufferedToolCalls = [];
      await writeChain;
      await writer.close();
    };
    const onToolCall = (pendingCall) => {
      bufferedToolCalls.push(pendingCall);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void flushToolCalls();
      }, TOOL_CALL_DEBOUNCE_MS);
    };
    const onUpdate = (update) => {
      if (streamClosed) return;
      const updateType = update.sessionUpdate;
      if (updateType === "agent_message_chunk") {
        const text = update.content?.text;
        if (text) {
          outputCharCount += text.length;
          if (!textStarted) {
            textStarted = true;
            writePart({ type: "stream-start", warnings: [] });
            writePart({ type: "text-start", id: textId });
          }
          writePart({ type: "text-delta", id: textId, delta: text });
        }
      } else if (updateType === "agent_thought_chunk") {
        const text = update.content?.text;
        if (text) {
          if (textStarted) {
            textStarted = false;
            writePart({ type: "text-end", id: textId });
          }
          if (!reasoningStarted) {
            reasoningStarted = true;
            writePart({ type: "stream-start", warnings: [] });
            writePart({ type: "reasoning-start", id: reasoningId });
          }
          writePart({ type: "reasoning-delta", id: reasoningId, delta: text });
        }
      } else if (updateType === "tool_call") {
        const { toolCallId, toolName, args: cleanArgs } = parseToolCallNotification(
          update
        );
        if (toolCallId && toolName) {
          laneRouter?.correlate(sessionId, toolCallId, toolName, cleanArgs);
        }
      }
    };
    const attachPromise = (promptPromise) => {
      promptPromise.then(async (result) => {
        if (streamClosed) return;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (bufferedToolCalls.length > 0) {
          await flushToolCalls();
          return;
        }
        if (reasoningStarted) {
          writePart({ type: "reasoning-end", id: reasoningId });
        }
        if (textStarted) {
          writePart({ type: "text-end", id: textId });
        }
        if (result.stopReason === "cancelled") {
          writePart({ type: "error", error: new Error("Request was cancelled by user") });
          removeAbortListener();
          this.pendingTurns.delete(sessionId);
          laneRouter?.unregister(sessionId);
          this.cleanupAfterStream(sessionId);
          streamClosed = true;
          try {
            await writeChain;
            await writer.close();
          } catch {
          }
          return;
        }
        const metadata = this.client.getMetadata(sessionId);
        const turnCredits = metadata?.meteringUsage?.find((m) => m.unit === "credit")?.value ?? 0;
        this.totalCredits += turnCredits;
        writePart({
          type: "finish",
          finishReason: mapStopReason(result.stopReason),
          usage: estimateUsage(outputCharCount, metadata?.contextUsagePercentage, this.config.contextWindow ?? 1e6),
          providerMetadata: metadata ? {
            kiro: {
              contextUsagePercentage: metadata.contextUsagePercentage ?? null,
              turnDurationMs: metadata.turnDurationMs ?? null,
              credits: metadata.meteringUsage?.find((m) => m.unit === "credit")?.value ?? null
            }
          } : void 0
        });
        removeAbortListener();
        this.pendingTurns.delete(sessionId);
        laneRouter?.unregister(sessionId);
        this.cleanupAfterStream(sessionId);
        streamClosed = true;
        await writeChain;
        await writer.close();
      }).catch(async (err) => {
        this.pendingTurns.delete(sessionId);
        laneRouter?.unregister(sessionId);
        this.cleanupAfterStream(sessionId);
        if (streamClosed) return;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (reasoningStarted) {
          writePart({ type: "reasoning-end", id: reasoningId });
        }
        if (textStarted) {
          writePart({ type: "text-end", id: textId });
        }
        writePart({ type: "error", error: err instanceof KiroACPError ? new Error(err.message) : new Error("An internal error occurred") });
        removeAbortListener();
        streamClosed = true;
        try {
          await writeChain;
          await writer.close();
        } catch {
        }
      });
    };
    return { readable, onUpdate, onToolCall, attachPromise };
  }
  // -------------------------------------------------------------------------
  // Fresh prompt flow
  // -------------------------------------------------------------------------
  async startFreshPrompt(options, reset = false) {
    const session = await this.acquireSession(options.tools);
    await this.ensureModel(session);
    let compositeText;
    const hasHistory = reset && options.prompt.some(
      (m) => m.role === "assistant" || m.role === "tool"
    );
    if (hasHistory) {
      compositeText = formatConversationReplay(options.prompt);
    } else {
      const { systemPrompt, userMessage } = extractPrompt(options.prompt);
      compositeText = systemPrompt ? `<system_instructions>
${systemPrompt}
</system_instructions>

${userMessage}` : userMessage;
    }
    const sessionId = session.sessionId;
    const promptAbort = new AbortController();
    const { readable, onUpdate, onToolCall, attachPromise } = this.createPromptStream({
      sessionId,
      promptAbort,
      initialOutputCharCount: 0,
      streamSegment: 0,
      options,
      savePendingTurn: (state) => {
        this.pendingTurns.set(sessionId, {
          sessionId,
          promptPromise,
          pendingToolCalls: state.pendingToolCalls,
          outputCharCount: state.outputCharCount,
          streamSegment: state.nextSegment,
          promptAbort
        });
      }
    });
    const laneRouter = this.client.getLaneRouter();
    laneRouter?.register(sessionId, onToolCall);
    const promptPromise = this.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: compositeText }],
      onUpdate,
      signal: promptAbort.signal
    });
    attachPromise(promptPromise);
    return {
      stream: readable,
      request: { body: compositeText },
      response: { headers: {} }
    };
  }
  // -------------------------------------------------------------------------
  // Resumption flow — doStream() called with tool results
  // -------------------------------------------------------------------------
  async resumeWithToolResults(sessionId, toolResults, options) {
    const turn = this.pendingTurns.get(sessionId);
    if (!turn) {
      throw new Error(`No pending turn for session ${sessionId}`);
    }
    const { readable, onUpdate, onToolCall, attachPromise } = this.createPromptStream({
      sessionId,
      promptAbort: turn.promptAbort,
      initialOutputCharCount: turn.outputCharCount,
      streamSegment: turn.streamSegment,
      options,
      savePendingTurn: (state) => {
        turn.pendingToolCalls = state.pendingToolCalls;
        turn.outputCharCount = state.outputCharCount;
        turn.streamSegment = state.nextSegment;
      }
    });
    const laneRouter = this.client.getLaneRouter();
    laneRouter?.updateHandler(sessionId, onToolCall);
    this.client.setPromptCallback(sessionId, onUpdate);
    for (const result of toolResults) {
      this.sendToolResult(result.toolCallId, result.result, false);
    }
    attachPromise(turn.promptPromise);
    return {
      stream: readable,
      request: { body: "[tool result resumption]" },
      response: { headers: {} }
    };
  }
  // -------------------------------------------------------------------------
  // Tool result delivery via IPC
  // -------------------------------------------------------------------------
  sendToolResult(callId, result, isError) {
    const ipcServer = this.client.getIPCServer();
    if (!ipcServer) {
      throw new Error("IPC server not available for sending tool result");
    }
    ipcServer.resolveToolResult({ callId, result, isError });
  }
  // -------------------------------------------------------------------------
  // LanguageModelV3 — doGenerate
  // -------------------------------------------------------------------------
  async doGenerate(options) {
    const result = await this.doStream(options);
    const content = [];
    const textParts = [];
    const reasoningParts = [];
    const toolInputs = /* @__PURE__ */ new Map();
    let finishReason = { unified: "other", raw: void 0 };
    let usage = emptyUsage();
    const flushText = () => {
      if (textParts.length > 0) {
        content.push({ type: "text", text: textParts.join("") });
        textParts.length = 0;
      }
    };
    const flushReasoning = () => {
      if (reasoningParts.length > 0) {
        content.push({ type: "reasoning", text: reasoningParts.join("") });
        reasoningParts.length = 0;
      }
    };
    const reader = result.stream.getReader();
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      switch (value.type) {
        case "text-delta":
          textParts.push(value.delta);
          break;
        case "text-end":
          flushText();
          break;
        case "reasoning-delta":
          reasoningParts.push(value.delta);
          break;
        case "reasoning-end":
          flushReasoning();
          break;
        case "tool-input-start":
          flushText();
          flushReasoning();
          toolInputs.set(value.id, { name: value.toolName, input: "" });
          break;
        case "tool-input-delta": {
          const tool = toolInputs.get(value.id);
          if (tool) tool.input += value.delta;
          break;
        }
        case "tool-call": {
          const tool = toolInputs.get(value.toolCallId);
          if (tool) {
            content.push({
              type: "tool-call",
              toolCallId: value.toolCallId,
              toolName: tool.name,
              input: tool.input
            });
          }
          break;
        }
        case "finish":
          finishReason = value.finishReason;
          usage = value.usage;
          break;
      }
    }
    flushText();
    flushReasoning();
    return {
      content,
      finishReason,
      usage,
      warnings: [],
      request: result.request,
      response: {
        headers: result.response?.headers
      }
    };
  }
};

// src/kiro-acp-provider.ts
function createKiroAcp(settings = {}) {
  const clientOptions = {
    cwd: settings.cwd ?? process.cwd(),
    agent: settings.agent,
    trustAllTools: settings.trustAllTools,
    agentPrompt: settings.agentPrompt,
    onPermission: settings.onPermission,
    env: settings.env,
    clientInfo: settings.clientInfo,
    mcpTimeout: settings.mcpTimeout
  };
  const client = new ACPClient(clientOptions);
  let lastModel = null;
  const createModel = (modelId, overrides) => {
    const model = new KiroACPLanguageModel(modelId, {
      client,
      sessionId: settings.sessionId,
      contextWindow: overrides?.contextWindow ?? settings.contextWindow
    });
    lastModel = model;
    return model;
  };
  const provider = ((modelId, overrides) => {
    return createModel(modelId, overrides);
  });
  provider.languageModel = createModel;
  provider.shutdown = async () => {
    await client.stop();
  };
  provider.getClient = () => {
    return client;
  };
  provider.getSessionId = () => {
    return lastModel?.getSessionId() ?? null;
  };
  provider.injectContext = async (summary) => {
    if (!lastModel) {
      throw new Error("No model instance created yet. Call provider(modelId) first.");
    }
    await lastModel.injectContext(summary);
  };
  provider.getTotalCredits = () => {
    return lastModel?.getTotalCredits() ?? 0;
  };
  return provider;
}

// src/kiro-models.ts
async function listModels(options) {
  const client = new ACPClient({
    cwd: options?.cwd ?? process.cwd()
  });
  try {
    await client.start();
    const session = await client.createSession();
    return session.models.availableModels;
  } finally {
    await client.stop();
  }
}

// src/kiro-quota.ts
async function getQuota(options) {
  const client = options?.client;
  if (!client) {
    return {
      sessionCredits: 0,
      contextUsagePercentage: void 0,
      metering: void 0
    };
  }
  const allMetadata = client.getAllMetadata();
  let totalCredits = 0;
  let lastContext;
  let lastMetering;
  for (const meta of allMetadata) {
    const credits = meta.meteringUsage?.find((m) => m.unit === "credit")?.value ?? 0;
    totalCredits += credits;
    lastContext = meta.contextUsagePercentage;
    lastMetering = meta.meteringUsage;
  }
  return {
    sessionCredits: totalCredits,
    contextUsagePercentage: lastContext,
    metering: lastMetering
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ACPClient,
  KiroACPConnectionError,
  KiroACPError,
  KiroACPLanguageModel,
  createIPCServer,
  createKiroAcp,
  generateAgentConfig,
  getQuota,
  listModels,
  verifyAuth,
  writeAgentConfig
});
//# sourceMappingURL=index.cjs.map