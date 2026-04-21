export function buildShellSpawn(
  shell: string,
  command: string,
): { args: string[]; command: string } {
  return {
    command: shell,
    args: [process.platform === "win32" ? "-lc" : "-ic", command],
  };
}

export function resolveRuntimeShell(): string {
  return process.env.SHELL || "/bin/sh";
}
