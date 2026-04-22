import { Command } from "commander";
import { registerDownCommand } from "./commands/down";
import { registerInitCommand } from "./commands/init";
import { registerStatusCommand } from "./commands/status";
import { registerUiCommand } from "./commands/ui";
import { registerUpCommand } from "./commands/up";

export function createCli(): Command {
  const program = new Command();

  program
    .name("dev")
    .description("Declarative local environment orchestration")
    .version("1.0.2");

  registerInitCommand(program);
  registerUpCommand(program);
  registerUiCommand(program);
  registerStatusCommand(program);
  registerDownCommand(program);

  return program;
}
