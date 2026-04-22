import { Command } from "commander";
import { createReadlinePrompter, runInitFlow } from "../core/init";
import { AppError } from "../utils/errors";
import { printInfo, printSuccess } from "../ui/output";
import { wrapCommand } from "./helpers";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create a .devrc.yml file through an interactive wizard")
    .action(
      wrapCommand(async () => {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new AppError("dev init requires an interactive terminal.");
        }

        const prompter = createReadlinePrompter();

        try {
          const result = await runInitFlow({ prompter });
          if (!result.written) {
            printInfo("Initialization cancelled.");
            return;
          }

          printSuccess(`Created ${result.configPath} for ${result.project}.`);
        } finally {
          prompter.close();
        }
      }),
    );
}
