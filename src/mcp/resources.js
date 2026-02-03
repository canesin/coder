import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { statePathFor } from "../state.js";

export function registerResources(server, defaultWorkspace) {
  server.resource(
    "state",
    "coder://state",
    { description: "Current .coder/state.json — workflow state including steps completed, selected issue, and branch" },
    async () => {
      const statePath = statePathFor(defaultWorkspace);
      if (!existsSync(statePath)) {
        return {
          contents: [{ uri: "coder://state", mimeType: "application/json", text: "{}" }],
        };
      }
      return {
        contents: [{
          uri: "coder://state",
          mimeType: "application/json",
          text: readFileSync(statePath, "utf8"),
        }],
      };
    },
  );

  server.resource(
    "issue",
    "coder://issue",
    { description: "ISSUE.md contents — the drafted issue specification" },
    async () => {
      const issuePath = path.join(defaultWorkspace, "ISSUE.md");
      if (!existsSync(issuePath)) {
        return {
          contents: [{ uri: "coder://issue", mimeType: "text/markdown", text: "ISSUE.md does not exist yet." }],
        };
      }
      return {
        contents: [{
          uri: "coder://issue",
          mimeType: "text/markdown",
          text: readFileSync(issuePath, "utf8"),
        }],
      };
    },
  );

  server.resource(
    "plan",
    "coder://plan",
    { description: "PLAN.md contents — the implementation plan" },
    async () => {
      const planPath = path.join(defaultWorkspace, "PLAN.md");
      if (!existsSync(planPath)) {
        return {
          contents: [{ uri: "coder://plan", mimeType: "text/markdown", text: "PLAN.md does not exist yet." }],
        };
      }
      return {
        contents: [{
          uri: "coder://plan",
          mimeType: "text/markdown",
          text: readFileSync(planPath, "utf8"),
        }],
      };
    },
  );

  server.resource(
    "critique",
    "coder://critique",
    { description: "PLANREVIEW.md contents — the plan review critique" },
    async () => {
      const critiquePath = path.join(defaultWorkspace, "PLANREVIEW.md");
      if (!existsSync(critiquePath)) {
        return {
          contents: [{
            uri: "coder://critique",
            mimeType: "text/markdown",
            text: "PLANREVIEW.md does not exist yet.",
          }],
        };
      }
      return {
        contents: [{
          uri: "coder://critique",
          mimeType: "text/markdown",
          text: readFileSync(critiquePath, "utf8"),
        }],
      };
    },
  );
}
