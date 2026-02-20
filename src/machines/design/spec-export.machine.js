import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineMachine } from "../_base.js";

export default defineMachine({
  name: "design.spec_export",
  description:
    "Export final design spec: write markdown summaries for each screen alongside PNG assets.",
  inputSchema: z.object({
    specDir: z.string().min(1),
    intentSpec: z.any(),
    refinedScreens: z.array(z.any()),
    accessibilityResults: z.array(z.any()).default([]),
    designTokens: z.any().nullable().default(null),
    projectId: z.string().default(""),
  }),

  async execute(input, ctx) {
    const {
      specDir,
      intentSpec,
      refinedScreens,
      accessibilityResults,
      designTokens,
    } = input;

    const a11yByScreen = new Map(
      accessibilityResults.map((a) => [a.screen, a]),
    );

    const exportedFiles = [];

    // Write per-screen markdown specs
    for (const screen of refinedScreens) {
      if (screen.error) continue;

      const slug = screen.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const mdPath = path.join(specDir, `${slug}.md`);
      const a11y = a11yByScreen.get(screen.name);

      const sections = [
        `# ${screen.name}`,
        "",
        `**Type:** ${screen.type || "page"}`,
        "",
        "## Description",
        screen.metadata?.description ||
          intentSpec?.screens?.find((s) => s.name === screen.name)
            ?.description ||
          "",
        "",
      ];

      // Image reference
      if (screen.imagePath) {
        sections.push(
          "## Preview",
          "",
          `![${screen.name}](${screen.imagePath})`,
          "",
        );
      }

      // Code
      if (screen.code) {
        sections.push(
          "## Generated Code",
          "",
          "```html",
          typeof screen.code === "string"
            ? screen.code
            : JSON.stringify(screen.code, null, 2),
          "```",
          "",
        );
      }

      // Responsive variant
      if (screen.responsiveVariant) {
        sections.push("## Responsive (Mobile)", "");
        if (screen.responsiveVariant.imagePath) {
          sections.push(
            `![${screen.name} Mobile](${screen.responsiveVariant.imagePath})`,
            "",
          );
        }
      }

      // Accessibility
      if (a11y) {
        sections.push("## Accessibility", "");
        if (Array.isArray(a11y.issues) && a11y.issues.length > 0) {
          for (const issue of a11y.issues) {
            sections.push(
              `- **${issue.severity || "info"}**: ${issue.message || issue.description || JSON.stringify(issue)}`,
            );
          }
        } else if (a11y.score !== undefined) {
          sections.push(`Score: ${a11y.score}`);
        } else {
          sections.push("No accessibility issues found.");
        }
        sections.push("");
      }

      // Metadata
      sections.push(
        "## Metadata",
        "",
        `- Screen ID: \`${screen.screenId || "n/a"}\``,
        `- Generated: ${new Date().toISOString()}`,
        "",
      );

      await writeFile(mdPath, sections.join("\n"), "utf8");
      exportedFiles.push(path.relative(ctx.workspaceDir, mdPath));

      if (screen.imagePath) {
        exportedFiles.push(screen.imagePath);
      }
    }

    // Write design tokens CSS/Tailwind if available
    if (designTokens) {
      if (designTokens.css) {
        const cssPath = path.join(specDir, "design-tokens.css");
        await writeFile(cssPath, designTokens.css, "utf8");
        exportedFiles.push(path.relative(ctx.workspaceDir, cssPath));
      }
      if (designTokens.tailwind) {
        const twPath = path.join(specDir, "tailwind-tokens.js");
        const content =
          typeof designTokens.tailwind === "string"
            ? designTokens.tailwind
            : `module.exports = ${JSON.stringify(designTokens.tailwind, null, 2)};\n`;
        await writeFile(twPath, content, "utf8");
        exportedFiles.push(path.relative(ctx.workspaceDir, twPath));
      }
    }

    // Write summary spec
    const summary = {
      projectName:
        intentSpec?.projectName || input.projectId || "design-project",
      intent: intentSpec?.intent || "",
      screens: refinedScreens.map((s) => ({
        name: s.name,
        type: s.type,
        imagePath: s.imagePath || null,
        hasResponsive: !!s.responsiveVariant,
        hasCode: !!s.code,
        error: s.error || null,
      })),
      accessibilityChecked: accessibilityResults.length,
      hasDesignTokens: !!designTokens,
      exportedFiles,
      exportedAt: new Date().toISOString(),
    };
    const summaryPath = path.join(specDir, "spec-summary.json");
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    exportedFiles.push(path.relative(ctx.workspaceDir, summaryPath));

    ctx.log({
      event: "design_export_complete",
      files: exportedFiles.length,
      screens: refinedScreens.filter((s) => !s.error).length,
    });

    return {
      status: "ok",
      data: {
        specDir: path.relative(ctx.workspaceDir, specDir),
        exportedFiles,
        summary,
      },
    };
  },
});
