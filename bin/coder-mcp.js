#!/usr/bin/env node
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs as nodeParseArgs } from "node:util";

import {
  earlyWorkspaceDirForMcp,
  hydrateMcpEnvFromLoginShell,
} from "../src/mcp-env-hydrate.js";

// Resolve the user's full login-shell PATH.
// MCP hosts (Claude Code, Cursor, etc.) often launch this process with a minimal
// environment that lacks nvm, cargo, homebrew, and other user-installed dirs.
// Keep this non-interactive so background MCP startup never engages shell
// job-control against the user's terminal.
try {
  const shellPath = execSync("bash -lc 'echo \"$PATH\"'", {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (shellPath) {
    const current = new Set(
      (process.env.PATH || "").split(":").filter(Boolean),
    );
    const merged = [...current];
    for (const dir of shellPath.split(":").filter(Boolean)) {
      if (!current.has(dir)) merged.push(dir);
    }
    process.env.PATH = merged.join(":");
  }
} catch {
  // Best-effort; fall through with existing PATH.
}

// Same situation as PATH: align with resolvePassEnv (coder.json + models.*.apiKeyEnv +
// passEnvPatterns). See hydrateMcpEnvFromLoginShell.
hydrateMcpEnvFromLoginShell(earlyWorkspaceDirForMcp());

const PKG_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerSharedMachines } from "../src/machines/shared/_registry.js";
import { registerPrompts } from "../src/mcp/prompts.js";
import { registerResources } from "../src/mcp/resources.js";
import { registerMachineTools } from "../src/mcp/tools/machines.js";
import { registerStatusTools } from "../src/mcp/tools/status.js";
import { registerSteeringTools } from "../src/mcp/tools/steering.js";
import { registerWorkflowTools } from "../src/mcp/tools/workflows.js";
import { createWorkspaceResolver } from "../src/mcp/workspace.js";
import { registerDesignMachines } from "../src/workflows/design.workflow.js";
import { registerDevelopMachines } from "../src/workflows/develop.workflow.js";
import { registerResearchMachines } from "../src/workflows/research.workflow.js";
import { registerSpecBuildMachines } from "../src/workflows/spec-build.workflow.js";

function usage() {
  return `coder-mcp

Usage:
  coder-mcp [--workspace <path>]
            [--transport <stdio|http>]
            [--host <host>] [--port <port>] [--path <route>]
            [--allowed-hosts <comma-separated-hostnames>]

Examples:
  coder-mcp --transport stdio
  coder-mcp --transport http --host 127.0.0.1 --port 8787 --path /mcp
`;
}

function parseCliArgs(argv) {
  const { values } = nodeParseArgs({
    args: argv.slice(2),
    strict: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      workspace: { type: "string", default: process.cwd() },
      transport: { type: "string", default: "stdio" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8787" },
      path: { type: "string", default: "/mcp" },
      "allowed-hosts": { type: "string", default: "" },
    },
  });

  const transport = String(values.transport || "stdio").toLowerCase();
  if (!["stdio", "http"].includes(transport)) {
    throw new Error(`Invalid --transport: ${transport} (expected stdio|http)`);
  }
  const port = Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port: ${values.port}`);
  }
  const routePath = String(values.path || "/mcp").startsWith("/")
    ? String(values.path || "/mcp")
    : `/${values.path}`;
  const allowedHosts = String(values["allowed-hosts"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    help: values.help,
    workspace: path.resolve(values.workspace || process.cwd()),
    transport,
    host: values.host,
    port,
    routePath,
    allowedHosts,
  };
}

function buildServer(defaultWorkspace, { httpMode = false } = {}) {
  const server = new McpServer(
    { name: "coder", version: PKG_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const resolveWorkspace = createWorkspaceResolver(defaultWorkspace, {
    httpMode,
  });

  registerDevelopMachines();
  registerResearchMachines();
  registerDesignMachines();
  registerSpecBuildMachines();
  registerSharedMachines();
  registerMachineTools(server, resolveWorkspace);
  registerWorkflowTools(server, resolveWorkspace);
  registerStatusTools(server, resolveWorkspace);
  registerSteeringTools(server, resolveWorkspace);
  registerResources(server, defaultWorkspace);
  registerPrompts(server);
  return server;
}

async function runStdio(workspace) {
  const server = buildServer(workspace, { httpMode: false });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
const SSE_KEEPALIVE_INTERVAL_MS = 30_000; // 30 seconds
const MAX_SESSIONS = 50;

async function runHttp({ workspace, host, port, routePath, allowedHosts }) {
  if (process.env.CODER_ALLOW_ANY_WORKSPACE === "1") {
    process.stderr.write(
      "[coder-mcp] WARNING: CODER_ALLOW_ANY_WORKSPACE=1 is active. " +
        "Any MCP client can target any directory on this machine.\n",
    );
  }

  const app = createMcpExpressApp({
    host,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
  });

  /** @type {Map<string, StreamableHTTPServerTransport>} */
  const transports = new Map();
  /** @type {Map<string, McpServer>} */
  const servers = new Map();
  /** @type {Map<string, number>} */
  const sessionLastSeen = new Map();
  /** Guards against TOCTOU race: concurrent POSTs could bypass MAX_SESSIONS
   *  because the capacity check and session registration span async work. */
  let pendingCreates = 0;

  // Workaround: @hono/node-server (used internally by StreamableHTTPServerTransport)
  // injects Content-Length and buffers SSE responses when Transfer-Encoding: chunked
  // is not set on the Web Standard Response. This kills the SSE stream prematurely.
  // Fix: intercept writeHead to force chunked encoding for SSE responses.
  const fixSseStreaming = (_req, res, next) => {
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, ...args) => {
      const headers =
        typeof args[0] === "object" && !Array.isArray(args[0])
          ? args[0]
          : args[1];
      if (headers) {
        const ct = headers["content-type"] || headers["Content-Type"] || "";
        if (ct.includes("text/event-stream")) {
          delete headers["content-length"];
          delete headers["Content-Length"];
          headers["transfer-encoding"] = "chunked";
        }
      }
      return origWriteHead(status, ...args);
    };
    next();
  };
  app.use(routePath, fixSseStreaming);

  app.post(routePath, async (req, res) => {
    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader)
        ? sessionIdHeader[0]
        : sessionIdHeader;
      let transport = sessionId ? transports.get(sessionId) || null : null;

      if (!transport) {
        if (sessionId) {
          res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Unknown or expired session ID" },
            id: null,
          });
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Initialization required. Send initialize request without mcp-session-id.",
            },
            id: null,
          });
          return;
        }

        // Evict oldest session when at capacity to prevent unbounded growth (#316)
        if (transports.size + pendingCreates >= MAX_SESSIONS) {
          let oldestSid = null;
          let oldestTime = Infinity;
          for (const [sid, ts] of sessionLastSeen) {
            if (ts < oldestTime) {
              oldestSid = sid;
              oldestTime = ts;
            }
          }
          if (oldestSid) {
            process.stderr.write(
              `[coder-mcp] Session limit reached (${MAX_SESSIONS}). ` +
                `Evicting oldest session ${oldestSid} ` +
                `(age: ${Math.round((Date.now() - oldestTime) / 1000)}s).\n`,
            );
            const oldTransport = transports.get(oldestSid);
            if (oldTransport) {
              try {
                await oldTransport.close();
              } catch {
                /* best-effort */
              }
              transports.delete(oldestSid);
            }
            const oldServer = servers.get(oldestSid);
            if (oldServer) {
              try {
                await oldServer.close();
              } catch {
                /* best-effort */
              }
              servers.delete(oldestSid);
            }
            sessionLastSeen.delete(oldestSid);
          }
        }

        pendingCreates++;
        try {
          const mcpServer = buildServer(workspace, { httpMode: true });
          // onsessioninitialized must be a constructor option — the Node.js
          // StreamableHTTPServerTransport wrapper does not forward property
          // setters for it (MCP SDK bug).
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              transports.set(newSessionId, transport);
              servers.set(newSessionId, mcpServer);
              sessionLastSeen.set(newSessionId, Date.now());
            },
          });

          transport.onclose = async () => {
            const sid = transport.sessionId;
            if (!sid) return;
            transports.delete(sid);
            sessionLastSeen.delete(sid);
            const s = servers.get(sid);
            servers.delete(sid);
            if (s) await s.close().catch(() => {});
          };

          await mcpServer.connect(transport);
        } finally {
          pendingCreates--;
        }
      }

      if (transport.sessionId)
        sessionLastSeen.set(transport.sessionId, Date.now());
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[coder-mcp] HTTP transport error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  const healthPath = routePath.endsWith("/")
    ? `${routePath}health`
    : `${routePath}/health`;
  app.get(healthPath, (_req, res) =>
    res.json({
      status: "ok",
      sessions: transports.size,
      maxSessions: MAX_SESSIONS,
    }),
  );

  app.get(routePath, async (req, res) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader)
      ? sessionIdHeader[0]
      : sessionIdHeader;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send("Invalid or missing mcp-session-id");
      return;
    }
    const transport = transports.get(sessionId);
    sessionLastSeen.set(sessionId, Date.now());
    try {
      await transport.handleRequest(req, res);
      // SSE keepalive: send periodic comment frames to prevent TCP idle
      // timeouts and keep sessionLastSeen fresh for the cleanup sweep (#316).
      // Only start if the response is still open (it's an SSE stream).
      if (!res.destroyed && !res.writableEnded) {
        const keepalive = setInterval(() => {
          if (res.destroyed || res.writableEnded) {
            clearInterval(keepalive);
            return;
          }
          try {
            res.write(":keepalive\n\n");
          } catch {
            clearInterval(keepalive);
            return;
          }
          sessionLastSeen.set(sessionId, Date.now());
        }, SSE_KEEPALIVE_INTERVAL_MS);
        res.on("close", () => clearInterval(keepalive));
      }
    } catch (err) {
      console.error("[coder-mcp] HTTP transport error (GET):", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.delete(routePath, async (req, res) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader)
      ? sessionIdHeader[0]
      : sessionIdHeader;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send("Invalid or missing mcp-session-id");
      return;
    }
    const transport = transports.get(sessionId);
    sessionLastSeen.set(sessionId, Date.now());
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[coder-mcp] HTTP transport error (DELETE):", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Periodic cleanup of stale sessions
  const cleanupInterval = setInterval(async () => {
    const now = Date.now();
    for (const [sid, lastSeen] of sessionLastSeen) {
      if (now - lastSeen < SESSION_TTL_MS) continue;
      sessionLastSeen.delete(sid);
      const transport = transports.get(sid);
      if (transport) {
        try {
          await transport.close();
        } catch {
          /* best-effort */
        }
        transports.delete(sid);
      }
      const server = servers.get(sid);
      if (server) {
        try {
          await server.close();
        } catch {
          /* best-effort */
        }
        servers.delete(sid);
      }
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
  cleanupInterval.unref();

  const listener = app.listen(port, host, () => {
    process.stdout.write(
      `[coder-mcp] HTTP transport listening on http://${host}:${port}${routePath} (workspace=${workspace})\n`,
    );
  });

  const shutdown = async () => {
    clearInterval(cleanupInterval);
    for (const [sessionId, transport] of transports.entries()) {
      try {
        await transport.close();
      } catch {
        /* best-effort */
      } finally {
        transports.delete(sessionId);
      }
    }
    for (const [sessionId, server] of servers.entries()) {
      try {
        await server.close();
      } catch {
        /* best-effort */
      } finally {
        servers.delete(sessionId);
      }
    }
    listener.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const args = parseCliArgs(process.argv);
if (args.help) {
  process.stdout.write(usage());
  process.exit(0);
}

if (args.transport === "stdio") {
  await runStdio(args.workspace);
} else {
  await runHttp({
    workspace: args.workspace,
    host: args.host,
    port: args.port,
    routePath: args.routePath,
    allowedHosts: args.allowedHosts,
  });
}
