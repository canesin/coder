import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

function isWithinRoot(root, candidate) {
  const rel = path.relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}

function resolveExistingRealPathOrParent(targetPath) {
  try {
    return realpathSync(targetPath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    let probe = path.dirname(targetPath);
    while (probe && probe !== path.dirname(probe)) {
      if (existsSync(probe)) return realpathSync(probe);
      probe = path.dirname(probe);
    }
    if (existsSync(probe)) return realpathSync(probe);
    throw err;
  }
}

export function resolveWorkspaceForMcp(
  workspace,
  defaultWorkspace,
  { httpMode = false } = {},
) {
  if (httpMode && !workspace) {
    throw Object.assign(
      new Error(
        "workspace parameter is required in HTTP mode. " +
          "Pass the absolute path to your project root.",
      ),
      { code: "WORKSPACE_REQUIRED" },
    );
  }
  if (httpMode && workspace && !path.isAbsolute(workspace)) {
    throw Object.assign(
      new Error(
        `workspace must be an absolute path in HTTP mode, got: "${workspace}". ` +
          "Relative paths resolve against the server cwd, not your project.",
      ),
      { code: "WORKSPACE_NOT_ABSOLUTE" },
    );
  }
  const rootPath = path.resolve(defaultWorkspace);
  const targetPath = path.resolve(workspace || defaultWorkspace);
  if (process.env.CODER_ALLOW_ANY_WORKSPACE === "1") return targetPath;

  const root = realpathSync(rootPath);
  const target = resolveExistingRealPathOrParent(targetPath);
  if (!isWithinRoot(root, target)) {
    throw new Error(
      `Workspace must be within server root: ${root}. ` +
        "Set CODER_ALLOW_ANY_WORKSPACE=1 to allow arbitrary paths.",
    );
  }
  try {
    return realpathSync(targetPath);
  } catch {
    return targetPath;
  }
}
