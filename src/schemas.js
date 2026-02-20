import { z } from "zod";

export const IssueItemSchema = z.object({
  source: z.enum(["github", "gitlab", "linear", "local"]),
  id: z.string().min(1),
  title: z.string().min(1),
  repo_path: z.string().default(""),
  difficulty: z.number().int().min(1).max(5).default(3),
  reason: z.string().default(""),
  depends_on: z.array(z.string()).default([]),
});

export const IssuesPayloadSchema = z.object({
  issues: z.array(IssueItemSchema),
  recommended_index: z.number().int(),
});

export const QuestionsPayloadSchema = z.object({
  questions: z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]),
});

export const ProjectsPayloadSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      key: z.string().default(""),
    }),
  ),
});

export const TestConfigSchema = z.object({
  setup: z.array(z.string()).default([]),
  healthCheck: z
    .object({
      url: z.string(),
      retries: z.number().int().positive().default(30),
      intervalMs: z.number().int().positive().default(2000),
    })
    .optional(),
  test: z.string().min(1),
  teardown: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(600000),
});
