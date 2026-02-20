import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineMachine } from "../_base.js";
import { resolveStitchAgent } from "./_shared.js";

export default defineMachine({
  name: "design.ui_refinement",
  description:
    "Iterate on generated UI designs with accessibility checks and responsive variants.",
  inputSchema: z.object({
    specDir: z.string().min(1),
    projectId: z.string().min(1),
    generatedScreens: z.array(z.any()),
    designContext: z.any().nullable().default(null),
  }),

  async execute(input, ctx) {
    const { specDir, projectId } = input;
    const generatedScreens = input.generatedScreens.filter((s) => !s.error);

    if (generatedScreens.length === 0) {
      return {
        status: "ok",
        data: {
          refinedScreens: [],
          accessibilityResults: [],
          designTokens: null,
        },
      };
    }

    // Resolve Stitch agent — gracefully skip if not configured
    let stitchAgent;
    try {
      ({ agent: stitchAgent } = resolveStitchAgent(ctx));
    } catch {
      return {
        status: "ok",
        data: {
          refinedScreens: generatedScreens,
          accessibilityResults: [],
          designTokens: null,
        },
      };
    }

    const refinedScreens = [];
    const accessibilityResults = [];

    for (const screen of generatedScreens) {
      const screenId = screen.screenId;
      if (!screenId) {
        refinedScreens.push(screen);
        continue;
      }

      // Accessibility check
      try {
        ctx.log({ event: "stitch_accessibility_check", screen: screen.name });
        const a11yResult = await stitchAgent.callToolText(
          "analyze_accessibility",
          { projectId, screenId },
        );
        const a11yData = JSON.parse(a11yResult);
        accessibilityResults.push({
          screen: screen.name,
          ...a11yData,
        });
      } catch (err) {
        ctx.log({
          event: "stitch_accessibility_error",
          screen: screen.name,
          error: err.message,
        });
      }

      // Generate responsive variant (mobile) if desktop
      let responsiveVariant = null;
      if (screen.type === "page") {
        try {
          ctx.log({ event: "stitch_responsive_variant", screen: screen.name });
          const variantResult = await stitchAgent.callToolText(
            "generate_responsive_variant",
            { projectId, screenId, device: "mobile" },
          );
          responsiveVariant = JSON.parse(variantResult);

          // Fetch mobile image
          if (responsiveVariant.screenId || responsiveVariant.id) {
            try {
              const mobileImage = await stitchAgent.callToolImage(
                "fetch_screen_image",
                {
                  projectId,
                  screenId: responsiveVariant.screenId || responsiveVariant.id,
                },
              );
              if (mobileImage) {
                const mobileFileName = `${screen.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-mobile.png`;
                const mobilePath = path.join(specDir, mobileFileName);
                await writeFile(
                  mobilePath,
                  Buffer.from(mobileImage.data, "base64"),
                );
                responsiveVariant.imagePath = path.relative(
                  ctx.workspaceDir,
                  mobilePath,
                );
              }
            } catch {
              // best-effort
            }
          }
        } catch (err) {
          ctx.log({
            event: "stitch_responsive_error",
            screen: screen.name,
            error: err.message,
          });
        }
      }

      refinedScreens.push({
        ...screen,
        responsiveVariant,
      });
    }

    // Generate design tokens
    let designTokens = null;
    try {
      ctx.log({ event: "stitch_design_tokens" });
      const tokensResult = await stitchAgent.callToolText(
        "generate_design_tokens",
        { projectId },
      );
      designTokens = JSON.parse(tokensResult);

      // Write design tokens to disk
      const tokensPath = path.join(specDir, "design-tokens.json");
      await writeFile(tokensPath, `${JSON.stringify(designTokens, null, 2)}\n`);
    } catch (err) {
      ctx.log({ event: "stitch_tokens_error", error: err.message });
    }

    // Save refinement state
    const refinementState = {
      refinedScreens,
      accessibilityResults,
      designTokens,
      refinedAt: new Date().toISOString(),
    };
    const statePath = path.join(specDir, "refinement-state.json");
    await writeFile(statePath, `${JSON.stringify(refinementState, null, 2)}\n`);

    ctx.log({
      event: "design_refinement_complete",
      screens: refinedScreens.length,
      a11yChecks: accessibilityResults.length,
    });

    return {
      status: "ok",
      data: {
        refinedScreens,
        accessibilityResults,
        designTokens,
      },
    };
  },
});
