import { Command } from "commander";
import { loadConfigFromArg, wrapCommand } from "./helpers";
import { parseCsvOption } from "../utils/command";
import { isSupervisorRunning, triggerUpSupervisor, upSupervisor } from "../core/supervisor";
import { formatSupervisorResponseSummary, printInfo, printSuccess, printWarning } from "../ui/output";
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

        if (await isSupervisorRunning(config.project)) {
          printWarning(`"${config.project}" already has an active session. Use "ui" to open the interface or "down" to stop it.`);
          return;
        }

        if (options.ui !== false) {
          printInfo(`${config.project}: starting services and opening UI.`);
          await triggerUpSupervisor(config, targets);
          await openSupervisorTui(config);
          return;
        }

        const response = await upSupervisor(config, targets);
        if (!response.ok) {
          throw new Error(response.message ?? "Unable to start supervisor.");
        }

        printSuccess(formatSupervisorResponseSummary(config.project, "services started", response));
      }),
    );
}
