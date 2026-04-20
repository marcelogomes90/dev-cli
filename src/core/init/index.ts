import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import YAML from "yaml";
import { AppError } from "../../utils/errors";
import { pathExists } from "../../utils/fs";
import { projectConfigSchema, type ProjectConfigInput } from "../config/schema";

const CONFIG_FILENAMES = [".devrc.yml", ".devrc.yaml"] as const;

interface GroupDraft {
  name: string;
}

interface ServiceDraft {
  name: string;
  group: string;
  cwd: string;
  command: string;
  installCommand?: string;
  autostart: boolean;
  dependsOn: string[];
}

export interface InitChoice {
  label: string;
  value: string;
}

export interface InitPrompter {
  prompt(message: string): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  select(message: string, choices: InitChoice[]): Promise<string>;
  selectMany(message: string, choices: InitChoice[]): Promise<string[]>;
  write(message: string): void;
  close(): void;
}

export interface RunInitOptions {
  cwd?: string;
  prompter: InitPrompter;
}

export interface RunInitResult {
  configPath: string;
  project?: string;
  written: boolean;
  yaml: string;
}

function buildChoiceMap(choices: InitChoice[]): Map<string, string> {
  const map = new Map<string, string>();

  choices.forEach((choice, index) => {
    const number = String(index + 1);
    map.set(number.toLowerCase(), choice.value);
    map.set(choice.value.toLowerCase(), choice.value);
  });

  return map;
}

export function createReadlinePrompter(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): InitPrompter {
  const rl = createInterface({ input, output });

  return {
    async prompt(message: string): Promise<string> {
      const answer = await rl.question(`${message}\n> `);
      return answer.trim();
    },
    async confirm(message: string, defaultValue = true): Promise<boolean> {
      const suffix = defaultValue ? " [Y/n]" : " [y/N]";

      while (true) {
        const raw = (await rl.question(`${message}${suffix}\n> `)).trim().toLowerCase();
        if (!raw) {
          return defaultValue;
        }

        if (["y", "yes"].includes(raw)) {
          return true;
        }

        if (["n", "no"].includes(raw)) {
          return false;
        }

        output.write("Enter yes or no.\n");
      }
    },
    async select(message: string, choices: InitChoice[]): Promise<string> {
      const renderedChoices = choices
        .map((choice, index) => `  ${index + 1}. ${choice.label}`)
        .join("\n");
      const validChoices = buildChoiceMap(choices);

      while (true) {
        const raw = (await rl.question(`${message}\n${renderedChoices}\n> `)).trim().toLowerCase();
        const selected = validChoices.get(raw);

        if (selected) {
          return selected;
        }

        output.write("Choose one of the listed options.\n");
      }
    },
    async selectMany(message: string, choices: InitChoice[]): Promise<string[]> {
      const renderedChoices = choices
        .map((choice, index) => `  ${index + 1}. ${choice.label}`)
        .join("\n");
      const validChoices = buildChoiceMap(choices);

      while (true) {
        const raw = (await rl.question(`${message}\n${renderedChoices}\nUse comma-separated numbers or names. Leave blank for none.\n> `))
          .trim()
          .toLowerCase();

        if (!raw) {
          return [];
        }

        const selected = raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => validChoices.get(value));

        if (selected.every(Boolean)) {
          return [...new Set(selected as string[])];
        }

        output.write("Choose only values from the listed options.\n");
      }
    },
    write(message: string): void {
      output.write(message);
    },
    close(): void {
      rl.close();
    },
  };
}

async function findExistingConfigFile(cwd: string): Promise<string | null> {
  const existing = [];

  for (const filename of CONFIG_FILENAMES) {
    if (await pathExists(path.join(cwd, filename))) {
      existing.push(filename);
    }
  }

  if (existing.length > 1) {
    throw new AppError("Found both .devrc.yml and .devrc.yaml in the current directory. Remove one before running dev init.");
  }

  return existing[0] ?? null;
}

async function promptRequiredValue(
  prompter: InitPrompter,
  message: string,
  validate?: (value: string) => string | null,
): Promise<string> {
  while (true) {
    const value = (await prompter.prompt(message)).trim();
    if (!value) {
      prompter.write("This value is required.\n");
      continue;
    }

    const error = validate?.(value) ?? null;
    if (error) {
      prompter.write(`${error}\n`);
      continue;
    }

    return value;
  }
}

async function promptOptionalValue(prompter: InitPrompter, message: string): Promise<string | undefined> {
  const value = (await prompter.prompt(message)).trim();
  return value ? value : undefined;
}

async function collectGroups(prompter: InitPrompter): Promise<GroupDraft[]> {
  const groups: GroupDraft[] = [];

  while (true) {
    const name = await promptRequiredValue(prompter, "Group name:", (value) => {
      return groups.some((group) => group.name === value) ? `Group "${value}" already exists.` : null;
    });

    groups.push({ name });

    if (!(await prompter.confirm("Create another group?", false))) {
      return groups;
    }
  }
}

async function collectServices(prompter: InitPrompter, groups: GroupDraft[]): Promise<ServiceDraft[]> {
  const services: ServiceDraft[] = [];
  const groupChoices = groups.map((group) => ({ label: group.name, value: group.name }));

  while (true) {
    const name = await promptRequiredValue(prompter, "Service name:", (value) => {
      return services.some((service) => service.name === value) ? `Service "${value}" already exists.` : null;
    });
    const group = await prompter.select(`Select the group for "${name}":`, groupChoices);
    const cwd = await promptRequiredValue(prompter, `Working directory for "${name}":`);
    const command = await promptRequiredValue(prompter, `Command for "${name}":`);
    const installCommand = await promptOptionalValue(
      prompter,
      `Install command for "${name}" (leave blank to skip):`,
    );
    const autostart = await prompter.confirm(`Autostart "${name}" when running dev up?`, true);

    services.push({
      autostart,
      command,
      cwd,
      dependsOn: [],
      group,
      installCommand,
      name,
    });

    if (!(await prompter.confirm("Create another service?", false))) {
      return services;
    }
  }
}

async function collectDependencies(prompter: InitPrompter, services: ServiceDraft[]): Promise<void> {
  for (const service of services) {
    const dependencyChoices = services
      .filter((candidate) => candidate.name !== service.name)
      .map((candidate) => ({ label: candidate.name, value: candidate.name }));

    if (dependencyChoices.length === 0) {
      service.dependsOn = [];
      continue;
    }

    if (!(await prompter.confirm(`Does "${service.name}" depend on other services?`, false))) {
      service.dependsOn = [];
      continue;
    }

    service.dependsOn = await prompter.selectMany(
      `Select dependencies for "${service.name}":`,
      dependencyChoices,
    );
  }
}

function buildConfigInput(project: string, groups: GroupDraft[], services: ServiceDraft[], editor?: string): ProjectConfigInput {
  const groupEntries: ProjectConfigInput["groups"] = Object.fromEntries(
    groups.map((group) => [
      group.name,
      {
        services: services
          .filter((service) => service.group === group.name)
          .map((service) => service.name),
      },
    ]),
  );

  const serviceEntries: ProjectConfigInput["services"] = Object.fromEntries(
    services.map((service) => {
      const serviceConfig: ProjectConfigInput["services"][string] = {
        command: service.command,
        cwd: service.cwd,
        group: service.group,
      };

      if (service.installCommand) {
        serviceConfig.installCommand = service.installCommand;
      }

      if (!service.autostart) {
        serviceConfig.autostart = false;
      }

      if (service.dependsOn.length > 0) {
        serviceConfig.dependsOn = service.dependsOn;
      }

      return [service.name, serviceConfig];
    }),
  );

  const config: ProjectConfigInput = {
    groups: groupEntries,
    project,
    services: serviceEntries,
  };

  if (editor) {
    config.editor = editor;
  }

  return config;
}

export function renderInitConfigYaml(config: ProjectConfigInput): string {
  const result = projectConfigSchema.safeParse(config);
  if (!result.success) {
    throw new AppError("Generated configuration is invalid.");
  }

  return YAML.stringify(result.data);
}

export async function runInitFlow({ cwd = process.cwd(), prompter }: RunInitOptions): Promise<RunInitResult> {
  const existingConfig = await findExistingConfigFile(cwd);
  const targetFilename = existingConfig ?? ".devrc.yml";
  const configPath = path.join(cwd, targetFilename);

  if (existingConfig) {
    const overwrite = await prompter.confirm(`Overwrite ${existingConfig}?`, false);
    if (!overwrite) {
      return {
        configPath,
        written: false,
        yaml: "",
      };
    }
  }

  const project = await promptRequiredValue(prompter, "Project name:");
  const editor = await promptOptionalValue(prompter, "Editor command (e.g. code, cursor — leave blank to skip):");
  prompter.write("\nCreate workspace groups.\n");
  const groups = await collectGroups(prompter);
  prompter.write("\nCreate workspace services.\n");
  const services = await collectServices(prompter, groups);
  prompter.write("\nConfigure service dependencies.\n");
  await collectDependencies(prompter, services);

  const config = buildConfigInput(project, groups, services, editor);
  const yaml = renderInitConfigYaml(config);
  prompter.write(`\nPreview for ${targetFilename}:\n\n${yaml}`);

  const shouldWrite = await prompter.confirm(`Write ${targetFilename}?`, true);
  if (!shouldWrite) {
    return {
      configPath,
      project,
      written: false,
      yaml,
    };
  }

  await writeFile(configPath, yaml, "utf8");

  return {
    configPath,
    project,
    written: true,
    yaml,
  };
}
