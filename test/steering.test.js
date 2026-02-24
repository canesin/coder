import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSteeringGenerationPrompt,
  loadSteeringContext,
  parseSteeringResponse,
  steeringDirFor,
  steeringFilePath,
  writeSteeringFiles,
} from "../src/steering.js";

function makeTmpWorkspace() {
  return mkdtempSync(path.join(os.tmpdir(), "steering-test-"));
}

test("loadSteeringContext: returns undefined when no files exist", () => {
  const ws = makeTmpWorkspace();
  assert.equal(loadSteeringContext(ws), undefined);
});

test("loadSteeringContext: reads from .coder/steering/ directory", () => {
  const ws = makeTmpWorkspace();
  const dir = steeringDirFor(ws);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "product.md"), "# Product\nTest product");
  writeFileSync(path.join(dir, "structure.md"), "# Structure\nTest structure");
  writeFileSync(path.join(dir, "tech.md"), "# Tech\nTest tech");

  const result = loadSteeringContext(ws);
  assert.ok(result.includes("# Product"));
  assert.ok(result.includes("# Structure"));
  assert.ok(result.includes("# Tech"));
  assert.ok(result.includes("---")); // separator between sections
});

test("loadSteeringContext: falls back to .coder/steering.md", () => {
  const ws = makeTmpWorkspace();
  mkdirSync(path.join(ws, ".coder"), { recursive: true });
  writeFileSync(steeringFilePath(ws), "# Combined steering\nFallback content");

  const result = loadSteeringContext(ws);
  assert.ok(result.includes("Fallback content"));
});

test("loadSteeringContext: directory takes priority over single file", () => {
  const ws = makeTmpWorkspace();
  const dir = steeringDirFor(ws);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "product.md"), "# Product from dir");
  writeFileSync(steeringFilePath(ws), "# Old single file");

  const result = loadSteeringContext(ws);
  assert.ok(result.includes("Product from dir"));
  assert.ok(!result.includes("Old single file"));
});

test("loadSteeringContext: skips missing files in directory", () => {
  const ws = makeTmpWorkspace();
  const dir = steeringDirFor(ws);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "product.md"), "# Product only");
  // structure.md and tech.md missing

  const result = loadSteeringContext(ws);
  assert.ok(result.includes("# Product only"));
  assert.ok(!result.includes("---")); // no separator since only one section
});

test("writeSteeringFiles: creates directory and writes files", () => {
  const ws = makeTmpWorkspace();
  const written = writeSteeringFiles(ws, {
    product: "# Product\nGenerated product",
    structure: "# Structure\nGenerated structure",
    tech: "# Tech\nGenerated tech",
  });

  assert.equal(written.length, 3);
  assert.ok(written.includes("product.md"));
  assert.ok(written.includes("structure.md"));
  assert.ok(written.includes("tech.md"));

  const dir = steeringDirFor(ws);
  assert.ok(existsSync(path.join(dir, "product.md")));
  assert.equal(
    readFileSync(path.join(dir, "product.md"), "utf8"),
    "# Product\nGenerated product",
  );

  // Also writes combined steering.md
  assert.ok(existsSync(steeringFilePath(ws)));
});

test("writeSteeringFiles: skips empty/null content", () => {
  const ws = makeTmpWorkspace();
  const written = writeSteeringFiles(ws, {
    product: "# Product",
    structure: "",
    tech: null,
  });

  assert.equal(written.length, 1);
  assert.ok(written.includes("product.md"));
});

test("writeSteeringFiles: ignores unknown file keys", () => {
  const ws = makeTmpWorkspace();
  const written = writeSteeringFiles(ws, {
    product: "# Product",
    unknown: "# Unknown section",
  });

  assert.equal(written.length, 1);
  assert.ok(!existsSync(path.join(steeringDirFor(ws), "unknown.md")));
});

test("parseSteeringResponse: extracts all three sections", () => {
  const response = `Here is the analysis:

<product>
# Product Context
This is a CLI tool.
</product>

<structure>
# Repository Structure
src/ contains the source code.
</structure>

<tech>
# Tech Stack
Node.js, JavaScript, Zod.
</tech>

Done.`;

  const result = parseSteeringResponse(response);
  assert.ok(result.product.includes("CLI tool"));
  assert.ok(result.structure.includes("source code"));
  assert.ok(result.tech.includes("Node.js"));
});

test("parseSteeringResponse: handles missing sections gracefully", () => {
  const response = `<product>
# Product
Only product here.
</product>`;

  const result = parseSteeringResponse(response);
  assert.ok(result.product);
  assert.equal(result.structure, undefined);
  assert.equal(result.tech, undefined);
});

test("parseSteeringResponse: returns empty object for no sections", () => {
  const result = parseSteeringResponse("No XML tags here at all.");
  assert.deepEqual(result, {});
});

test("buildSteeringGenerationPrompt: includes repo root", () => {
  const prompt = buildSteeringGenerationPrompt("/foo/bar");
  assert.ok(prompt.includes("/foo/bar"));
  assert.ok(prompt.includes("<product>"));
  assert.ok(prompt.includes("<structure>"));
  assert.ok(prompt.includes("<tech>"));
});
