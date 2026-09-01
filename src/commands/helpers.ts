import { loadProjectConfig, type ProjectConfig } from "../core/config";
import { isSupervisorRunning, shutdownSupervisor } from "../core/supervisor";
import { getErrorMessage } from "../utils/errors";
import {
  createServiceLabelResolver,
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
  const resolveLabel = createServiceLabelResolver(config);

  // Printed before the failure check so the user sees which service refused to stop.
  for (const result of response.results ?? []) {
    printDetail(formatServiceResultLine(result, resolveLabel(result.service)));
  }

  if (!response.ok) {
    throw new Error(response.message ?? "Unable to stop supervisor.");
  }

  printSuccess(`${config.project}: stopped.`);
}
