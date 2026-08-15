import { loadProjectConfig, type ProjectConfig } from "../core/config";
import { isSupervisorRunning, shutdownSupervisor } from "../core/supervisor";
import { getErrorMessage } from "../utils/errors";
import {
  formatServiceResultLine,
  printDetail,
  printError,
  printInfo,
  printSuccess,
  printWarning,
} from "../ui/output";

export function wrapCommand<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await handler(...args);
    } catch (error) {
      printError(getErrorMessage(error));
      process.exitCode = 1;
    }
  };
}

export async function loadConfigFromArg(project: string) {
  return loadProjectConfig(project);
}

export async function stopProject(config: ProjectConfig): Promise<void> {
  if (!(await isSupervisorRunning(config.project))) {
    printWarning(`${config.project}: no active session to stop.`);
    return;
  }

  printInfo(`${config.project}: stopping services and releasing ports...`);

  const response = await shutdownSupervisor(config);
  if (!response.ok) {
    throw new Error(response.message ?? "Unable to stop supervisor.");
  }

  for (const result of response.results ?? []) {
    printDetail(formatServiceResultLine(result, config.services[result.service]?.title ?? result.service));
  }

  printSuccess(`${config.project}: stopped.`);
}
