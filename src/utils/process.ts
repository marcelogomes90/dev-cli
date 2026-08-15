import { execa } from "execa";

const PORT_RELEASE_TIMEOUT_MS = 2_000;

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killProcess(pid: number | null | undefined, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(
  pid: number | null | undefined,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  if (!pid || !isProcessAlive(pid)) {
    return true;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return !isProcessAlive(pid);
}

export async function findPortListenerPids(port: number): Promise<number[]> {
  let stdout: string;

  try {
    /**
     * `lsof` exits with code 1 when nothing is listening, so failures are expected here.
     * `-sTCP:LISTEN` keeps clients connected to the port from being reported as owners.
     */
    const result = await execa("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { reject: false });
    stdout = result.stdout;
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
      pids.push(pid);
    }
  }

  return pids;
}

export interface FreedPort {
  pid: number;
  port: number;
}

export async function freePorts(ports: number[]): Promise<FreedPort[]> {
  const uniquePorts = [...new Set(ports)];
  if (uniquePorts.length === 0) {
    return [];
  }

  const perPort = await Promise.all(
    uniquePorts.map(async (port) => {
      const freed: FreedPort[] = [];

      for (const pid of await findPortListenerPids(port)) {
        if (!killProcess(pid, "SIGTERM")) {
          continue;
        }

        if (!(await waitForProcessExit(pid, PORT_RELEASE_TIMEOUT_MS))) {
          killProcess(pid, "SIGKILL");
        }

        freed.push({ pid, port });
      }

      return freed;
    }),
  );

  return perPort.flat();
}

export async function getProcessTree(rootPid: number | null | undefined): Promise<number[]> {
  if (!rootPid) {
    return [];
  }

  const result = await execa("ps", ["-ax", "-o", "pid=", "-o", "ppid="], { reject: true });
  const childrenByParent = new Map<number, number[]>();

  for (const line of result.stdout.split("\n")) {
    const [pidValue, parentValue] = line
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));

    if (!Number.isFinite(pidValue) || !Number.isFinite(parentValue)) {
      continue;
    }

    const children = childrenByParent.get(parentValue) ?? [];
    children.push(pidValue);
    childrenByParent.set(parentValue, children);
  }

  const ordered: number[] = [];
  const visit = (pid: number) => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      visit(childPid);
    }
    ordered.push(pid);
  };

  visit(rootPid);
  return ordered;
}

export async function terminateProcessTree(
  rootPid: number | null | undefined,
  signal: NodeJS.Signals,
): Promise<void> {
  const tree = await getProcessTree(rootPid);
  for (const pid of tree) {
    killProcess(pid, signal);
  }
}
