import type { ProjectConfig } from "../config";
import { AppError } from "../../utils/errors";

export const DEPENDENCY_START_DELAY_MS = 5_000;

export interface SupervisorPlan {
  orderedServices: string[];
  servicesByGroup: Record<string, string[]>;
  startupPhases: string[][];
}

export function resolveTargets(
  config: ProjectConfig,
  target?: string,
): string[] {
  if (!target) {
    return Object.values(config.services)
      .filter((service) => service.autostart)
      .map((service) => service.name);
  }

  if (config.services[target]) {
    return [target];
  }

  if (config.groups[target]) {
    return [...config.groups[target].services];
  }

  throw new AppError(`Unknown target "${target}". Expected a group or service name.`);
}

function collectDependencies(
  config: ProjectConfig,
  initialServices: string[],
): Set<string> {
  const seen = new Set<string>();
  const stack = [...initialServices];

  while (stack.length > 0) {
    const serviceName = stack.pop()!;
    if (seen.has(serviceName)) {
      continue;
    }
    seen.add(serviceName);

    for (const dependency of config.services[serviceName]?.dependsOn ?? []) {
      stack.push(dependency);
    }
  }

  return seen;
}

function topologicalSort(config: ProjectConfig, serviceNames: string[]): string[] {
  const allowed = new Set(serviceNames);
  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const ordered: string[] = [];

  const visit = (serviceName: string) => {
    if (permanent.has(serviceName)) {
      return;
    }

    if (temporary.has(serviceName)) {
      throw new AppError(`Dependency cycle detected involving "${serviceName}".`);
    }

    temporary.add(serviceName);
    for (const dependency of config.services[serviceName].dependsOn) {
      if (allowed.has(dependency)) {
        visit(dependency);
      }
    }
    temporary.delete(serviceName);
    permanent.add(serviceName);
    ordered.push(serviceName);
  };

  for (const serviceName of serviceNames) {
    visit(serviceName);
  }

  return ordered;
}

function buildStartupPhases(config: ProjectConfig, orderedServices: string[]): string[][] {
  const allowed = new Set(orderedServices);
  const phaseByService = new Map<string, number>();
  const startupPhases: string[][] = [];

  for (const serviceName of orderedServices) {
    const dependencies = config.services[serviceName].dependsOn.filter((dependency) => allowed.has(dependency));
    const phase =
      dependencies.length === 0
        ? 0
        : Math.max(...dependencies.map((dependency) => phaseByService.get(dependency) ?? 0)) + 1;

    phaseByService.set(serviceName, phase);
    startupPhases[phase] ??= [];
    startupPhases[phase].push(serviceName);
  }

  return startupPhases;
}

export function buildSupervisorPlan(
  config: ProjectConfig,
  serviceNames: string[],
  includeDependencies = true,
): SupervisorPlan {
  const selected = includeDependencies
    ? [...collectDependencies(config, serviceNames)]
    : [...new Set(serviceNames)];
  const orderedServices = topologicalSort(config, selected);
  const servicesByGroup: Record<string, string[]> = {};
  const startupPhases = buildStartupPhases(config, orderedServices);

  for (const serviceName of orderedServices) {
    const groupName = config.services[serviceName].group;
    servicesByGroup[groupName] ??= [];
    servicesByGroup[groupName].push(serviceName);
  }

  return { orderedServices, servicesByGroup, startupPhases };
}
