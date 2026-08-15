import { Command } from "commander";
import { loadConfigFromArg, stopProject, wrapCommand } from "./helpers";
import { ensureSupervisor } from "../core/supervisor";
import { openSupervisorTui } from "../ui/tui";
import { printInfo } from "../ui/output";

export function registerUiCommand(program: Command): void {
  program
    .command("ui")
    .argument("<project>", "Project name declared in .devrc.yml")
    .description("Open the local environment UI without starting services")
    .action(
      wrapCommand(async (project: string) => {
        const config = await loadConfigFromArg(project);
        printInfo(`${config.project}: opening UI.`);
        await ensureSupervisor(config);
        const result = await openSupervisorTui(config);
        if (result.shutdownRequested) {
          await stopProject(config);
        }
      }),
    );
}
