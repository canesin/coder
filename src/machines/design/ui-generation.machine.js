import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineMachine } from "../_base.js";
import { resolveStitchAgent } from "./_shared.js";

export default defineMachine({
  name: "design.ui_generation",
  description:
    "Generate UI screens via Google Stitch MCP server based on intent spec.",
  inputSchema: z.object({
    specDir: z.string().min(1),
    intentPath: z.string().min(1),
    intentSpec: z.any(),
  }),

  async execute(input, ctx) {
    const { specDir, intentSpec } = input;

    // Load intent spec from disk if not provided inline
    let spec = intentSpec;
    if (!spec) {
      try {
        spec = JSON.parse(await readFile(input.intentPath, "utf8"));
      } catch {
        spec = null;
      }
    }
    if (!spec || !Array.isArray(spec.screens)) {
      throw new Error("Intent spec missing or has no screens.");
    }

    const { agent: stitchAgent } = resolveStitchAgent(ctx);

    // Create Stitch project
    const projectName = spec.projectName || "coder-design";
    let projectId;
    try {
      const createResult = await stitchAgent.callToolText("create_project", {
        name: projectName,
        description: spec.intent || "",
      });
      const createData = JSON.parse(createResult);
      projectId = createData.projectId || createData.id || projectName;
    } catch (err) {
      ctx.log({ event: "stitch_create_project_fallback", error: err.message });
      projectId = projectName;
    }

    // Extract design context if style references exist
    let designContext = null;
    if (spec.designSystem) {
      try {
        const contextResult = await stitchAgent.callToolText(
          "extract_design_context",
          {
            projectId,
            colorScheme: spec.designSystem.colorScheme || "light",
            primaryColor: spec.designSystem.primaryColor || "",
            typography: spec.designSystem.typography || "",
            style: spec.designSystem.style || spec.style || "",
          },
        );
        designContext = JSON.parse(contextResult);
      } catch (err) {
        ctx.log({
          event: "stitch_design_context_fallback",
          error: err.message,
        });
      }
    }

    // Generate screens
    const generatedScreens = [];
    for (const screen of spec.screens) {
      ctx.log({ event: "stitch_generating_screen", name: screen.name });

      const screenPrompt = [
        screen.description,
        screen.elements?.length > 0
          ? `Key elements: ${screen.elements.join(", ")}`
          : "",
        screen.interactions?.length > 0
          ? `Interactions: ${screen.interactions.join(", ")}`
          : "",
        designContext ? `Design context: ${JSON.stringify(designContext)}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      try {
        const generateResult = await stitchAgent.callToolText(
          "generate_screen_from_text",
          {
            projectId,
            prompt: screenPrompt,
            screenName: screen.name,
          },
        );
        const screenData = JSON.parse(generateResult);

        // Fetch image
        let imagePath = null;
        try {
          const imageResult = await stitchAgent.callToolImage(
            "fetch_screen_image",
            {
              projectId,
              screenId: screenData.screenId || screenData.id,
            },
          );
          if (imageResult) {
            const imgFileName = `${screen.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
            imagePath = path.join(specDir, imgFileName);
            await writeFile(imagePath, Buffer.from(imageResult.data, "base64"));
          }
        } catch (imgErr) {
          ctx.log({
            event: "stitch_fetch_image_error",
            screen: screen.name,
            error: imgErr.message,
          });
        }

        // Fetch code
        let code = null;
        try {
          code = await stitchAgent.callToolText("fetch_screen_code", {
            projectId,
            screenId: screenData.screenId || screenData.id,
          });
        } catch (codeErr) {
          ctx.log({
            event: "stitch_fetch_code_error",
            screen: screen.name,
            error: codeErr.message,
          });
        }

        generatedScreens.push({
          name: screen.name,
          type: screen.type,
          screenId: screenData.screenId || screenData.id,
          imagePath: imagePath
            ? path.relative(ctx.workspaceDir, imagePath)
            : null,
          code,
          metadata: screenData,
        });
      } catch (err) {
        ctx.log({
          event: "stitch_generate_error",
          screen: screen.name,
          error: err.message,
        });
        generatedScreens.push({
          name: screen.name,
          type: screen.type,
          error: err.message,
        });
      }
    }

    // Save generation state
    const generationState = {
      projectId,
      designContext,
      screens: generatedScreens,
      generatedAt: new Date().toISOString(),
    };
    const statePath = path.join(specDir, "generation-state.json");
    await writeFile(statePath, `${JSON.stringify(generationState, null, 2)}\n`);

    ctx.log({
      event: "design_generation_complete",
      total: spec.screens.length,
      successful: generatedScreens.filter((s) => !s.error).length,
    });

    return {
      status: "ok",
      data: {
        specDir,
        projectId,
        designContext,
        generatedScreens,
        statePath,
      },
    };
  },
});
