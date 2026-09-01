import os from "node:os";
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
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

// Also accepts project-suffixed files (.devrc.<name>.yml), so one directory can
// host the configs of several projects and `dev up <project>` picks the right one.
const CONFIG_FILE_PATTERN = /^\.devrc(\.[\w-]+)?\.ya?ml$/;

function normalizeHookCommands(hooks: ProjectConfigInput["hooks"]): HooksConfig {
  const toArray = (value: string | string[] | undefined): string[] =>
    typeof value === "string" ? [value] : value ?? [];

  return {
    beforeUp: toArray(hooks?.beforeUp),
    afterUp: toArray(hooks?.afterUp),
    beforeDown: toArray(hooks?.beforeDown),
  };
}

function normalizePorts(port: number | number[] | undefined): number[] {
  if (port === undefined) {
    return [];
  }

  return typeof port === "number" ? [port] : [...new Set(port)];
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

  const portOwners = new Map<number, string>();

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

    /**
     * Declared ports are freed before every start, so two services sharing one would kill
     * each other while a dependency phase starts them in parallel.
     */
    for (const port of service.ports) {
      const owner = portOwners.get(port);
      if (owner) {
        throw new AppError(
          `Services "${owner}" and "${serviceName}" both declare port ${port}. Each port must belong to a single service.`,
        );
      }

      portOwners.set(port, serviceName);
    }
  }
}

/**
 * `stat` follows symlinks, so a config symlinked into the workspace still counts as a file.
 * The directory entry alone reports it as a link and would drop it from the candidates.
 */
async function isConfigFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export async function findConfigFile(cwd = process.cwd()): Promise<string> {
  for (const filename of CONFIG_FILES) {
    const candidate = path.join(cwd, filename);

    if (await isConfigFile(candidate)) {
      return candidate;
    }
  }

  throw new AppError(
    `No configuration file found in ${cwd}. Expected one of: ${CONFIG_FILES.join(", ")}.`,
  );
}

async function listConfigFiles(cwd: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(cwd);
  } catch {
    return [];
  }

  const candidates = entries
    .filter((entry) => CONFIG_FILE_PATTERN.test(entry))
    .map((entry) => path.join(cwd, entry))
    .sort();

  const usable = await Promise.all(candidates.map(isConfigFile));

  return candidates.filter((_, index) => usable[index]);
}

async function parseConfigFile(configPath: string): Promise<ProjectConfigInput> {
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
    throw new AppError(`${path.basename(configPath)}:\n${formatZodError(result.error)}`);
  }

  return result.data;
}

export async function loadProjectConfig(projectName: string, cwd = process.cwd()): Promise<ProjectConfig> {
  const configFiles = await listConfigFiles(cwd);

  if (configFiles.length === 0) {
    throw new AppError(
      `No configuration file found in ${cwd}. Expected ${CONFIG_FILES.join(", ")} or .devrc.<project>.yml.`,
    );
  }

  let input: ProjectConfigInput | undefined;
  let configPath = "";
  const availableProjects: string[] = [];

  for (const candidatePath of configFiles) {
    const candidate = await parseConfigFile(candidatePath);
    availableProjects.push(candidate.project);

    if (candidate.project === projectName) {
      input = candidate;
      configPath = candidatePath;
      break;
    }
  }

  if (!input) {
    throw new AppError(
      `No config in ${cwd} declares project "${projectName}". Available projects: ${availableProjects.join(", ")}.`,
    );
  }

  const rootDir = path.dirname(configPath);

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
        ports: normalizePorts(service.port),
        title: service.title ?? serviceName,
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
