import { createHash } from "node:crypto";
import path from "node:path";

function sanitizeSegment(value, { fallback = "workspace" } = {}) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function durableServiceName(workspaceDir) {
  const abs = path.resolve(workspaceDir);
  const base = sanitizeSegment(path.basename(abs), { fallback: "workspace" });
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 8);
  return `coder-mcp-durable-${base}-${hash}.service`;
}

export function defaultLitestreamConfigText() {
  return `# Litestream bootstrap for coder scratchpad SQLite durability.
# Set LITESTREAM_REPLICA_URL in .coder/litestream.env.

sync-interval: 15s

snapshot:
  interval: 1h
  retention: 168h

logging:
  level: info
  type: text
  stderr: true

dbs:
  - path: .coder/state.db
    replica:
      url: \${LITESTREAM_REPLICA_URL}
`;
}

export function defaultDurabilityEnvText() {
  return `# Litestream environment for coder durability service.
# Set this to your destination (examples: s3://, gs://, abs://, sftp://, webdav://, file://)
LITESTREAM_REPLICA_URL=

# HTTP endpoint for coder-mcp daemon mode.
CODER_MCP_HOST=127.0.0.1
CODER_MCP_PORT=8787
CODER_MCP_PATH=/mcp
# Optional, comma-separated (example: localhost,127.0.0.1)
CODER_MCP_ALLOWED_HOSTS=

# Optional provider-specific environment:
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_REGION=
`;
}

export function shellQuote(text) {
  return `'${String(text ?? "").replace(/'/g, `'"'"'`)}'`;
}

export function renderDurableSystemdUnit({
  workspaceDir,
  scope = "system",
  envFilePath,
  coderBin,
}) {
  const absWorkspace = path.resolve(workspaceDir);
  const absEnv = path.resolve(envFilePath);
  const runCmd = `${shellQuote(coderBin)} durability run --workspace ${shellQuote(absWorkspace)}`;
  const wantedBy = scope === "user" ? "default.target" : "multi-user.target";
  return `[Unit]
Description=Coder MCP durable service (${absWorkspace})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${absWorkspace}
EnvironmentFile=-${absEnv}
ExecStart=/usr/bin/env bash -lc ${shellQuote(runCmd)}
Restart=always
RestartSec=3
TimeoutStopSec=30
NoNewPrivileges=true

[Install]
WantedBy=${wantedBy}
`;
}

export function upsertEnvVar(text, key, value) {
  const lines = String(text || "")
    .split("\n")
    .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ""));
  let found = false;
  const updated = lines.map((line) => {
    if (!line.startsWith(`${key}=`)) return line;
    found = true;
    return `${key}=${value}`;
  });
  if (!found) updated.push(`${key}=${value}`);
  return `${updated.join("\n")}\n`;
}
