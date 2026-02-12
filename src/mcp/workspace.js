import path from "node:path";

export function resolveWorkspaceForMcp(workspace, defaultWorkspace) {
  const root = path.resolve(defaultWorkspace);
  const target = path.resolve(workspace || defaultWorkspace);
  if (process.env.CODER_ALLOW_ANY_WORKSPACE === "1") return target;

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(
      `Workspace must be within server root: ${root}. ` +
        "Set CODER_ALLOW_ANY_WORKSPACE=1 to allow arbitrary paths.",
    );
  }
  return target;
}
