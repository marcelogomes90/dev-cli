import os from "node:os";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";

const SUPERVISOR_ROOT = path.join(os.tmpdir(), "dev-cli-supervisor");

export interface SupervisorPaths {
  baseDir: string;
  logsDir: string;
  socketPath: string;
  statePath: string;
}

export function getSupervisorPaths(project: string): SupervisorPaths {
  const safeProject = project.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const baseDir = path.join(SUPERVISOR_ROOT, safeProject);

  return {
    baseDir,
    logsDir: path.join(baseDir, "logs"),
    socketPath: path.join(baseDir, "supervisor.sock"),
    statePath: path.join(baseDir, "state.json"),
  };
}

export async function ensureSupervisorDirs(project: string): Promise<SupervisorPaths> {
  const paths = getSupervisorPaths(project);
  await mkdir(paths.logsDir, { recursive: true });
  return paths;
}

export async function clearSupervisorFiles(project: string): Promise<void> {
  const paths = getSupervisorPaths(project);
  await rm(paths.baseDir, { recursive: true, force: true });
}
