import { readFile, writeFile } from "node:fs/promises";
import type { SupervisorState } from "./types";
import { ensureSupervisorDirs, getSupervisorPaths } from "./paths";

export async function loadSupervisorState(project: string): Promise<SupervisorState | null> {
  const paths = getSupervisorPaths(project);
  try {
    const raw = await readFile(paths.statePath, "utf8");
    return JSON.parse(raw) as SupervisorState;
  } catch {
    return null;
  }
}

export async function saveSupervisorState(state: SupervisorState): Promise<void> {
  const paths = await ensureSupervisorDirs(state.project);
  await writeFile(
    paths.statePath,
    JSON.stringify(
      {
        ...state,
        socketPath: paths.socketPath,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
