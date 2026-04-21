import path from "node:path";
import type { ProjectConfig } from "../config";
import { getSupervisorPaths } from "./paths";
import type { ManagedServiceState } from "./types";

export function createServiceState(
  project: string,
  group: string,
  service: ProjectConfig["services"][string],
): ManagedServiceState {
  const paths = getSupervisorPaths(project);

  return {
    branch: "-",
    command: service.command,
    cwd: service.cwd,
    exitCode: null,
    group,
    installCommand: service.installCommand,
    isGit: false,
    lastStartedAt: null,
    lastStoppedAt: null,
    logPath: path.join(paths.logsDir, `${service.name}.log`),
    pid: null,
    service: service.name,
    status: "stopped",
  };
}
