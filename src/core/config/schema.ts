import { z } from "zod";

const hookValueSchema = z.union([z.string(), z.array(z.string())]).optional();

export const serviceSchema = z.object({
  cwd: z.string().min(1),
  command: z.string().min(1),
  installCommand: z.string().min(1).optional(),
  group: z.string().min(1),
  autostart: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
});

export const projectConfigSchema = z.object({
  project: z.string().min(1),
  session: z.string().min(1).optional(),
  groups: z.record(
    z.string().min(1),
    z.object({
      services: z.array(z.string().min(1)),
      layout: z.string().min(1).optional(),
    }),
  ),
  hooks: z
    .object({
      beforeUp: hookValueSchema,
      afterUp: hookValueSchema,
      beforeDown: hookValueSchema,
    })
    .optional(),
  services: z.record(z.string().min(1), serviceSchema),
  editor: z.string().min(1).optional(),
});

export type ProjectConfigInput = z.infer<typeof projectConfigSchema>;
