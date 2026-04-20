import os from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import YAML from "yaml";
import { ZodError } from "zod";
import { AppError } from "../../utils/errors";
import { sanitizeName } from "../../utils/strings";
import { projectConfigSchema, type ProjectConfigInput } from "./schema";
import type {
  GroupConfig,
  HooksConfig,
  ProjectConfig,
  ServiceConfig,
} from "./types";

const CONFIG_FILES = [".devrc.yml", ".devrc.yaml"];

function normalizeHookCommands(hooks: ProjectConfigInput["hooks"]): HooksConfig {
  const toArray = (value: string | string[] | undefined): string[] =>
    typeof value === "string" ? [value] : value ?? [];

  return {
    beforeUp: toArray(hooks?.beforeUp),
    afterUp: toArray(hooks?.afterUp),
    beforeDown: toArray(hooks?.beforeDown),
  };
}

function resolvePathValue(value: string, rootDir: string): string {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  if (path.isAbsolute(value)) {
    return path.normalize(value);
  }

  return path.resolve(rootDir, value);
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const pointer = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${pointer}: ${issue.message}`;
    })
    .join("\n");
}

function validateGraph(
  groups: Record<string, GroupConfig>,
  services: Record<string, ServiceConfig>,
): void {
  const serviceNames = new Set(Object.keys(services));

  for (const [groupName, group] of Object.entries(groups)) {
    for (const serviceName of group.services) {
      if (!serviceNames.has(serviceName)) {
        throw new AppError(
          `Group "${groupName}" references unknown service "${serviceName}".`,
        );
      }
    }
  }

  for (const [serviceName, service] of Object.entries(services)) {
    if (!groups[service.group]) {
      throw new AppError(
        `Service "${serviceName}" references unknown group "${service.group}".`,
      );
    }

    if (!groups[service.group].services.includes(serviceName)) {
      throw new AppError(
        `Service "${serviceName}" must be listed in groups.${service.group}.services.`,
      );
    }

    for (const dependency of service.dependsOn) {
      if (!serviceNames.has(dependency)) {
        throw new AppError(
          `Service "${serviceName}" depends on unknown service "${dependency}".`,
        );
      }
    }
  }
}

export async function findConfigFile(cwd = process.cwd()): Promise<string> {
  for (const filename of CONFIG_FILES) {
    const candidate = path.join(cwd, filename);

    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  throw new AppError(
    `No configuration file found in ${cwd}. Expected one of: ${CONFIG_FILES.join(", ")}.`,
  );
}

export async function loadProjectConfig(projectName: string, cwd = process.cwd()): Promise<ProjectConfig> {
  const configPath = await findConfigFile(cwd);
  const rootDir = path.dirname(configPath);
  const fileContents = await readFile(configPath, "utf8");

  let parsed: unknown;
  try {
    parsed = YAML.parse(fileContents);
  } catch (error) {
    throw new AppError(
      `Failed to parse ${path.basename(configPath)}: ${(error as Error).message}`,
    );
  }

  const result = projectConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(formatZodError(result.error));
  }

  const input = result.data;

  if (input.project !== projectName) {
    throw new AppError(
      `Config project "${input.project}" does not match requested project "${projectName}".`,
    );
  }

  const groups: Record<string, GroupConfig> = Object.fromEntries(
    Object.entries(input.groups).map(([groupName, group]) => [
      groupName,
      {
        layout: group.layout,
        services: [...group.services],
      },
    ]),
  );

  const services: Record<string, ServiceConfig> = Object.fromEntries(
    Object.entries(input.services).map(([serviceName, service]) => [
      serviceName,
      {
        autostart: service.autostart ?? true,
        command: service.command,
        cwd: resolvePathValue(service.cwd, rootDir),
        dependsOn: service.dependsOn ?? [],
        env: service.env ?? {},
        group: service.group,
        installCommand: service.installCommand,
        name: serviceName,
      },
    ]),
  );

  validateGraph(groups, services);

  return {
    configPath,
    editor: input.editor,
    groups,
    hooks: normalizeHookCommands(input.hooks),
    project: input.project,
    rootDir,
    services,
    session: sanitizeName(input.session ?? input.project),
  };
}

export * from "./types";
