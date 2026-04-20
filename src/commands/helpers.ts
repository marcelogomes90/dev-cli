import { loadProjectConfig } from "../core/config";
import { getErrorMessage } from "../utils/errors";
import { printError } from "../ui/output";

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
