import { realpathSync } from "node:fs";
import path from "node:path";

export function resolveWorkspaceForMcp(workspace, defaultWorkspace) {
  let root;
  try {
    root = realpathSync(path.resolve(defaultWorkspace));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `Workspace directory does not exist: ${defaultWorkspace}`,
      );
    }
    throw err;
  }
  const targetPath = path.resolve(workspace || defaultWorkspace);

  if (process.env.CODER_ALLOW_ANY_WORKSPACE === "1") return targetPath;

  // Resolve symlinks to get the real path for security check
  let realTarget;
  try {
    realTarget = realpathSync(targetPath);
  } catch (targetErr) {
    // Path doesn't exist yet (e.g., creating new directory)
    // Check that the parent directory is within root
    if (targetErr.code !== "ENOENT") {
      console.warn(
        `Unexpected error resolving path ${targetPath}: ${targetErr.message}`,
      );
    }
    const parentPath = path.dirname(targetPath);
    try {
      const realParent = realpathSync(parentPath);
      if (realParent !== root && !realParent.startsWith(root + path.sep)) {
        throw new Error(
          `Workspace must be within server root: ${root}. ` +
            "Set CODER_ALLOW_ANY_WORKSPACE=1 to allow arbitrary paths.",
        );
      }
    } catch (parentErr) {
      // Parent also doesn't exist - allow if the logical path is within root
      if (parentErr.code !== "ENOENT") {
        console.warn(
          `Unexpected error resolving parent ${parentPath}: ${parentErr.message}`,
        );
      }
      if (targetPath !== root && !targetPath.startsWith(root + path.sep)) {
        throw new Error(
          `Workspace must be within server root: ${root}. ` +
            "Set CODER_ALLOW_ANY_WORKSPACE=1 to allow arbitrary paths.",
        );
      }
    }
    return targetPath;
  }

  if (realTarget !== root && !realTarget.startsWith(root + path.sep)) {
    throw new Error(
      `Workspace must be within server root: ${root}. ` +
        "Set CODER_ALLOW_ANY_WORKSPACE=1 to allow arbitrary paths.",
    );
  }
  return targetPath;
}
