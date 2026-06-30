import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { SupervisorState } from "./types";
import { ensureSupervisorDirs, getSupervisorPaths } from "./paths";

// Distinguishes concurrent writes (a command and the 1s refresh tick can both persist
// state) so each lands on its own temp file before the atomic rename.
let writeSequence = 0;

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
  const payload = JSON.stringify(
    {
      ...state,
      socketPath: paths.socketPath,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );

  // Write to a unique temp file then rename: rename is atomic on POSIX, so a crash mid-write
  // can never leave a half-written (unparseable) state.json behind.
  writeSequence += 1;
  const tempPath = `${paths.statePath}.${process.pid}.${writeSequence}.tmp`;
  try {
    await writeFile(tempPath, payload);
    await rename(tempPath, paths.statePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
