import { Command } from "commander";
import { readSupervisorState } from "../core/supervisor";
import { buildStatusRowsFromConfig, buildStatusRowsFromState, renderTable, STATUS_TABLE_HEAD } from "../ui/output";
import { loadConfigFromArg, wrapCommand } from "./helpers";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .argument("<project>", "Project name declared in .devrc.yml")
    .description("Show the current service table for the project")
    .action(
      wrapCommand(async (project: string) => {
        const config = await loadConfigFromArg(project);
        const state = await readSupervisorState(config.project);
        const rows = state ? buildStatusRowsFromState(state) : buildStatusRowsFromConfig(config);

        renderTable(STATUS_TABLE_HEAD, rows);
      }),
    );
}
