import { createCli } from "./cli";
import { getErrorMessage } from "./utils/errors";
import { printError } from "./ui/output";

createCli()
  .parseAsync(process.argv)
  .catch((error) => {
    printError(getErrorMessage(error));
    process.exitCode = 1;
  });
