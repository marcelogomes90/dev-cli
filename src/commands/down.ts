import { Command } from "commander";
import { loadConfigFromArg, stopProject, wrapCommand } from "./helpers";

export function registerDownCommand(program: Command): void {
  program
    .command("down")
    .argument("<project>", "Project name declared in .devrc.yml")
    .description("Stop all services managed by the local supervisor")
    .action(
      wrapCommand(async (project: string) => {
        const config = await loadConfigFromArg(project);
        await stopProject(config);
      }),
    );
}
