import { Command } from "commander";
import { shutdownSupervisor } from "../core/supervisor";
import { printSuccess } from "../ui/output";
import { loadConfigFromArg, wrapCommand } from "./helpers";

export function registerDownCommand(program: Command): void {
  program
    .command("down")
    .argument("<project>", "Project name declared in .devrc.yml")
    .description("Stop all services managed by the local supervisor")
    .action(
      wrapCommand(async (project: string) => {
        const config = await loadConfigFromArg(project);
        const response = await shutdownSupervisor(config);
        if (!response.ok) {
          throw new Error(response.message ?? "Unable to stop supervisor.");
        }
        printSuccess(`${config.project}: stopped.`);
      }),
    );
}
