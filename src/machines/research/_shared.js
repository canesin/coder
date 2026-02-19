import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  extractGeminiPayloadJson,
  extractJson,
  formatCommandFailure,
} from "../../helpers.js";

/**
 * Chunk a large pointer text into manageable pieces for analysis.
 * @param {string} text
 * @param {{ maxChars?: number, maxChunks?: number }} [opts]
 * @returns {string[]}
 */
export function chunkPointers(text, { maxChars = 12000, maxChunks = 24 } = {}) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) return [];

  const chunks = [];
  let cursor = 0;
  while (cursor < normalized.length && chunks.length < maxChunks) {
    let end = Math.min(cursor + maxChars, normalized.length);
    if (end < normalized.length) {
      const newlineBoundary = normalized.lastIndexOf("\n", end);
      if (newlineBoundary > cursor + Math.floor(maxChars * 0.5)) {
        end = newlineBoundary;
      }
    }
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    cursor = end;
  }

  if (cursor < normalized.length && chunks.length > 0) {
    const omitted = normalized.length - cursor;
    chunks[chunks.length - 1] +=
      `\n\n[TRUNCATED: ${omitted} chars omitted due to chunk limit]`;
  }

  return chunks;
}

/**
 * Sanitize a string for use as a filename segment.
 * @param {string} value
 * @param {{ fallback?: string }} [opts]
 * @returns {string}
 */
export function sanitizeFilenameSegment(value, { fallback = "item" } = {}) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

/**
 * Parse structured JSON from agent output.
 * @param {string} agentName
 * @param {string} stdout
 */
export function parseAgentPayload(agentName, stdout) {
  return agentName === "gemini"
    ? extractGeminiPayloadJson(stdout)
    : extractJson(stdout);
}

/**
 * Ensure an agent result has exit code 0, throw otherwise.
 * @param {string} agentName
 * @param {string} label
 * @param {{ exitCode: number, stdout?: string, stderr?: string }} res
 */
export function requireExitZero(agentName, label, res) {
  if (res.exitCode !== 0) {
    throw new Error(formatCommandFailure(`${agentName} ${label}`, res));
  }
}

/**
 * Run a structured agent step: execute prompt, parse JSON output, save artifact.
 *
 * @param {{
 *   stepName: string,
 *   artifactName?: string,
 *   role: string,
 *   prompt: string,
 *   timeoutMs?: number,
 *   stepsDir: string,
 *   scratchpadPath: string,
 *   pipeline: object,
 *   pipelinePath: string,
 *   ctx: import("../_base.js").WorkflowContext & { agentPool: any },
 * }} opts
 * @returns {Promise<{ payload: any, agentName: string, outputPath: string, relOutputPath: string }>}
 */
export async function runStructuredStep({
  stepName,
  artifactName,
  role,
  prompt,
  timeoutMs = 1000 * 60 * 10,
  stepsDir,
  scratchpadPath,
  pipeline,
  pipelinePath,
  ctx,
}) {
  if (ctx.cancelToken.cancelled) throw new Error("Run cancelled");

  await beginPipelineStep(pipeline, pipelinePath, scratchpadPath, stepName, {
    role,
  });
  const { agentName, agent } = ctx.agentPool.getAgent(role, {
    scope: "workspace",
  });

  const res = await agent.executeWithRetry(prompt, { timeoutMs });
  if (res.exitCode !== 0) {
    await endPipelineStep(
      pipeline,
      pipelinePath,
      scratchpadPath,
      stepName,
      "failed",
      {
        agent: agentName,
      },
    );
    throw new Error(
      formatCommandFailure(`${agentName} ${stepName} failed`, res),
    );
  }

  const payload = parseAgentPayload(agentName, res.stdout);
  const outputPath = path.join(
    stepsDir,
    `${sanitizeFilenameSegment(artifactName || stepName, { fallback: "step" })}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  const relOutputPath = path.relative(ctx.workspaceDir, outputPath);
  await endPipelineStep(
    pipeline,
    pipelinePath,
    scratchpadPath,
    stepName,
    "completed",
    {
      agent: agentName,
      artifact: relOutputPath,
    },
  );
  return { payload, agentName, outputPath, relOutputPath };
}

/**
 * Load a step artifact from the run directory.
 * @param {string} stepsDir
 * @param {string} artifactName
 * @returns {Promise<any|null>}
 */
export async function loadStepArtifact(stepsDir, artifactName) {
  const p = path.join(
    stepsDir,
    `${sanitizeFilenameSegment(artifactName, { fallback: "step" })}.json`,
  );
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Resolve a parameter that may be an empty default ({}) or null.
 * Returns the parameter if it has content, otherwise loads from stepsDir.
 */
export async function resolveArtifact(param, stepsDir, artifactName) {
  if (
    param != null &&
    typeof param === "object" &&
    Object.keys(param).length > 0
  )
    return param;
  if (Array.isArray(param) && param.length > 0) return param;
  return (await loadStepArtifact(stepsDir, artifactName)) || {};
}

/**
 * Append a section to the scratchpad markdown file.
 */
export async function appendScratchpad(filePath, heading, lines = []) {
  const body = Array.isArray(lines)
    ? lines.filter((line) => line !== null && line !== undefined)
    : [String(lines)];
  const block = [
    "",
    `## ${heading}`,
    `- timestamp: ${new Date().toISOString()}`,
    ...body,
    "",
  ].join("\n");
  await appendFile(filePath, block, "utf8");
}

/**
 * Initialize the research run directory structure.
 * @param {string} scratchpadDir
 * @returns {Promise<{ runId: string, runDir: string, issuesDir: string, stepsDir: string, pointersDir: string, scratchpadPath: string, pipelinePath: string }>}
 */
export async function initRunDirectory(scratchpadDir) {
  const runId = `idea-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const runDir = path.join(scratchpadDir, runId);
  const issuesDir = path.join(runDir, "issues");
  const stepsDir = path.join(runDir, "steps");
  const pointersDir = path.join(runDir, "pointers");
  await mkdir(issuesDir, { recursive: true });
  await mkdir(stepsDir, { recursive: true });
  await mkdir(pointersDir, { recursive: true });

  const scratchpadPath = path.join(runDir, "SCRATCHPAD.md");
  const pipelinePath = path.join(runDir, "pipeline.json");

  return {
    runId,
    runDir,
    issuesDir,
    stepsDir,
    pointersDir,
    scratchpadPath,
    pipelinePath,
  };
}

/**
 * Create and persist the initial pipeline state.
 */
export async function initPipeline(runId, pipelinePath) {
  const pipeline = {
    version: 1,
    runId,
    current: "init",
    history: [],
    steps: {},
  };
  await writeFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`);
  return pipeline;
}

/**
 * Load pipeline state from disk.
 */
export async function loadPipeline(pipelinePath) {
  try {
    return JSON.parse(await readFile(pipelinePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Begin a pipeline step.
 */
export async function beginPipelineStep(
  pipeline,
  pipelinePath,
  scratchpadPath,
  name,
  meta = {},
) {
  pipeline.current = name;
  pipeline.history.push({
    at: new Date().toISOString(),
    event: "step_start",
    step: name,
    ...meta,
  });
  pipeline.steps[name] = {
    status: "running",
    startedAt: new Date().toISOString(),
    ...meta,
  };
  await writeFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`);
  await appendScratchpad(scratchpadPath, `Step: ${name}`, [
    "- status: running",
  ]);
}

/**
 * End a pipeline step.
 */
export async function endPipelineStep(
  pipeline,
  pipelinePath,
  scratchpadPath,
  name,
  status,
  meta = {},
) {
  pipeline.history.push({
    at: new Date().toISOString(),
    event: "step_end",
    step: name,
    status,
    ...meta,
  });
  pipeline.steps[name] = {
    ...(pipeline.steps[name] || {}),
    status,
    endedAt: new Date().toISOString(),
    ...meta,
  };
  await writeFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`);
  await appendScratchpad(scratchpadPath, `Step: ${name}`, [
    `- status: ${status}`,
    ...Object.entries(meta).map(([k, v]) => `- ${k}: ${String(v)}`),
  ]);
}

/**
 * Mark a step as skipped in the pipeline.
 */
export async function skipPipelineStep(
  pipeline,
  pipelinePath,
  scratchpadPath,
  name,
  reason,
) {
  await beginPipelineStep(pipeline, pipelinePath, scratchpadPath, name, {});
  await endPipelineStep(
    pipeline,
    pipelinePath,
    scratchpadPath,
    name,
    "skipped",
    { reason },
  );
}

/**
 * Render a research issue as structured markdown.
 */
export function renderIdeaIssueMarkdown({
  issue,
  issueId,
  title,
  repoPath,
  pointers,
  scratchpadRelPath,
}) {
  const asLines = (value) =>
    Array.isArray(value)
      ? value.map((line) => String(line || "").trim()).filter(Boolean)
      : [];
  const asText = (value, fallback = "") =>
    String(value || "").trim() || fallback;

  const tags = asLines(issue?.tags);
  const dependsOn = asLines(issue?.depends_on);
  const changes = asLines(issue?.changes);
  const acceptance = asLines(issue?.acceptance_criteria);
  const researchQuestions = asLines(issue?.research_questions);
  const outOfScope = asLines(issue?.out_of_scope);
  const risks = asLines(issue?.risks);
  const references = Array.isArray(issue?.references)
    ? issue.references
        .map((ref) => ({
          source: asText(ref?.source, "other"),
          title: asText(ref?.title, "reference"),
          url: asText(ref?.url, ""),
          why: asText(ref?.why, ""),
        }))
        .filter((ref) => ref.url || ref.title)
    : [];
  const validation =
    issue && typeof issue.validation === "object" && issue.validation
      ? issue.validation
      : null;
  const validationEvidence = asLines(validation?.evidence);
  const validationLimitations = asLines(validation?.limitations);

  const bullet = (items, fallback) =>
    items.length > 0
      ? items.map((item) => `- ${item}`).join("\n")
      : `- ${fallback}`;

  return `# ${issueId} - ${title}

Status: backlog
Priority: ${asText(issue?.priority, "P2")}
Tags: ${tags.join(", ") || "research"}
Depends-On: ${dependsOn.join(", ") || "_none_"}

## Issue Graph

| Key | Value |
|-----|-------|
| depends_on | ${dependsOn.join(", ") || "_none_"} |
| blocks | _tbd_ |
| tags | \`${tags.join("`, `") || "research"}\` |
| estimated_effort | ${asText(issue?.estimated_effort, "unknown")} |

## Goal
${asText(issue?.objective, "Define and validate the minimal change required by this issue.")}

## Problem
${asText(issue?.problem, "Current behavior and constraints must be validated against the local codebase.")}

## Scope
${bullet(changes, "Define concrete file-level changes after research validation.")}

## Deliverables
- Updated implementation and/or docs matching the scope above.
- Evidence notes captured in \`${scratchpadRelPath}\`.
- Verification command output or test result.

## Research Questions
${bullet(researchQuestions, "List unanswered technical questions discovered during execution.")}

## Acceptance Criteria
${bullet(acceptance, "Include at least one measurable success criterion and one concrete verification command.")}

## Testing Strategy
### Existing Tests
${bullet(asLines(issue?.testing_strategy?.existing_tests), "No existing tests identified.")}
### New Tests to Write
${bullet(asLines(issue?.testing_strategy?.new_tests), "No new tests specified.")}
### Test Patterns
${asText(issue?.testing_strategy?.test_patterns, "No test pattern notes provided.")}

## Verification
\`\`\`bash
${asText(issue?.verification, 'echo "define verification command" && exit 1')}
\`\`\`

## Non-Goals
${bullet(outOfScope, "Any refactor or feature not strictly required for this issue.")}

## Risks and Gaps
${bullet(risks, "Unknown constraints discovered during implementation.")}

## External References
${references.length > 0 ? references.map((ref) => `- [${ref.title}](${ref.url || "#"}) (${ref.source})${ref.why ? ` - ${ref.why}` : ""}`).join("\n") : "- (none provided)"}

## Direction Validation
- mode: ${asText(validation?.mode, "analysis")}
- status: ${asText(validation?.status, "not_run")}
- method: ${asText(validation?.method, "not specified")}
- evidence:
${bullet(validationEvidence, "No validation evidence captured.")}
- limitations:
${bullet(validationLimitations, "No limitations documented.")}

## Metadata
- repo_path: ${repoPath}
- notes: ${asText(issue?.notes, "(none)")}
- scratchpad: ${scratchpadRelPath}

## Source Pointers
\`\`\`text
${pointers}
\`\`\`

## Scratchpad
- Date:
- Decision notes:
- Blockers:
- Next action:
`;
}
