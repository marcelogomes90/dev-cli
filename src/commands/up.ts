import { Command } from "commander";
import { loadConfigFromArg, wrapCommand } from "./helpers";
import { parseCsvOption } from "../utils/command";
import { triggerUpSupervisor, upSupervisor } from "../core/supervisor";
import { printSuccess } from "../ui/output";
import { openSupervisorTui } from "../ui/tui";

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .argument("<project>", "Project name declared in .devrc.yml")
    .option("--only <targets>", "Comma-separated list of groups or services")
    .option("--no-ui", "Start services without opening the UI")
    .description("Start the project environment with the local supervisor")
    .action(
      wrapCommand(async (project: string, options: { only?: string; ui?: boolean }) => {
        const config = await loadConfigFromArg(project);
        const targets = parseCsvOption(options.only);

        if (options.ui !== false) {
          await triggerUpSupervisor(config, targets);
          await openSupervisorTui(config);
          return;
        }

        const response = await upSupervisor(config, targets);
        if (!response.ok) {
          throw new Error(response.message ?? "Unable to start supervisor.");
        }

        printSuccess(`Supervisor "${config.project}" is running.`);
      }),
    );
}
