import os from "node:os";
import { readFile } from "node:fs/promises";
import { execa } from "execa";

const MEMORY_REFRESH_INTERVAL_MS = 3_000;

export interface ProcessResourceRow {
  cpuTimeMs: number;
  pid: number;
  ppid: number;
  rssBytes: number;
}

export interface ProcessResourceSample {
  memoryBytesByPid?: Map<number, number>;
  memorySampledAtMs?: number;
  rows: ProcessResourceRow[];
  sampledAtMs: number;
}

export interface ProcessTreeResourceMetrics {
  cpuPercent: number | null;
  memoryBytes: number | null;
}

export interface ProcessTreeResourceMetricsResult {
  metricsByPid: Map<number, ProcessTreeResourceMetrics>;
  sample: ProcessResourceSample;
}

interface CollectProcessTreeResourceMetricsOptions {
  cpuCount?: number;
  memoryBytesByPid?: ReadonlyMap<number, number>;
}

interface WindowsProcessInfo {
  KernelModeTime?: number | string | null;
  ParentProcessId?: number | string | null;
  ProcessId?: number | string | null;
  UserModeTime?: number | string | null;
  WorkingSetSize?: number | string | null;
}

export function parseLinuxSmapsRollupPss(output: string): number | null {
  const match = output.match(/^Pss:\s+(\d+)\s+kB$/im);
  return match ? Number.parseInt(match[1], 10) * 1024 : null;
}

export function parseProcessCpuTime(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) {
    return null;
  }

  const [dayValue, timeValue] = normalized.includes("-")
    ? normalized.split("-", 2)
    : ["0", normalized];
  const days = Number.parseInt(dayValue, 10);
  const timeParts = timeValue.split(":");
  if (!Number.isFinite(days) || timeParts.length < 1 || timeParts.length > 3) {
    return null;
  }

  const seconds = Number.parseFloat(timeParts[timeParts.length - 1] ?? "");
  const minutes = timeParts.length >= 2 ? Number.parseInt(timeParts[timeParts.length - 2] ?? "", 10) : 0;
  const hours = timeParts.length >= 3 ? Number.parseInt(timeParts[timeParts.length - 3] ?? "", 10) : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) {
    return null;
  }

  return Math.round(((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000);
}

export function parseProcessResourceRows(output: string): ProcessResourceRow[] {
  const rows: ProcessResourceRow[] = [];

  for (const line of output.split("\n")) {
    const [pidValue, ppidValue, rssValue, cpuTimeValue] = line.trim().split(/\s+/);
    if (!pidValue || !ppidValue || !rssValue || !cpuTimeValue) {
      continue;
    }

    const pid = Number.parseInt(pidValue, 10);
    const ppid = Number.parseInt(ppidValue, 10);
    const rssKilobytes = Number.parseInt(rssValue, 10);
    const cpuTimeMs = parseProcessCpuTime(cpuTimeValue);
    if (
      !Number.isFinite(pid) ||
      !Number.isFinite(ppid) ||
      !Number.isFinite(rssKilobytes) ||
      cpuTimeMs === null
    ) {
      continue;
    }

    rows.push({
      cpuTimeMs: Math.max(cpuTimeMs, 0),
      pid,
      ppid,
      rssBytes: Math.max(rssKilobytes, 0) * 1024,
    });
  }

  return rows;
}

function indexRowsByPid(rows: Iterable<ProcessResourceRow>): Map<number, ProcessResourceRow> {
  const rowsByPid = new Map<number, ProcessResourceRow>();
  for (const row of rows) {
    rowsByPid.set(row.pid, row);
  }
  return rowsByPid;
}

function getChildrenByParent(rows: Iterable<ProcessResourceRow>): Map<number, number[]> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }
  return childrenByParent;
}

function collectTreePids(
  rowsByPid: ReadonlyMap<number, ProcessResourceRow>,
  childrenByParent: ReadonlyMap<number, number[]>,
  rootPid: number,
): number[] {
  if (!rowsByPid.has(rootPid)) {
    return [];
  }

  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }

  return [...seen];
}

export function collectProcessTreeResourceMetrics(
  rows: ProcessResourceRow[],
  rootPids: Iterable<number>,
  previousRows: Iterable<ProcessResourceRow> = [],
  elapsedMs: number | null = null,
  options: CollectProcessTreeResourceMetricsOptions = {},
): Map<number, ProcessTreeResourceMetrics> {
  const rowsByPid = indexRowsByPid(rows);
  const previousRowsByPid = indexRowsByPid(previousRows);
  const childrenByParent = getChildrenByParent(rows);
  const cpuCount = Math.max(options.cpuCount ?? os.cpus().length, 1);

  const metricsByRoot = new Map<number, ProcessTreeResourceMetrics>();
  for (const rootPid of new Set(rootPids)) {
    const treePids = collectTreePids(rowsByPid, childrenByParent, rootPid);
    if (treePids.length === 0) {
      continue;
    }

    let currentCpuTimeMs = 0;
    let previousCpuTimeMs = 0;
    let memoryBytes = 0;

    for (const pid of treePids) {
      const row = rowsByPid.get(pid);
      if (!row) {
        continue;
      }

      currentCpuTimeMs += row.cpuTimeMs;
      previousCpuTimeMs += previousRowsByPid.get(pid)?.cpuTimeMs ?? 0;
      memoryBytes += options.memoryBytesByPid?.get(pid) ?? row.rssBytes;
    }

    const cpuDeltaMs = currentCpuTimeMs - previousCpuTimeMs;
    const cpuPercent =
      elapsedMs && elapsedMs > 0 && cpuDeltaMs >= 0
        ? Math.max(0, Math.min(100, Math.round(((cpuDeltaMs / elapsedMs) * 100) / cpuCount)))
        : null;

    metricsByRoot.set(rootPid, {
      cpuPercent,
      memoryBytes,
    });
  }

  return metricsByRoot;
}

async function readUnixProcessResourceRows(): Promise<ProcessResourceRow[]> {
  const result = await execa("ps", ["-ax", "-o", "pid=", "-o", "ppid=", "-o", "rss=", "-o", "time="], {
    reject: true,
  });

  return parseProcessResourceRows(result.stdout);
}

function getWindowsPowerShellCommand(): string {
  return process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWindowsProcessRows(raw: string): ProcessResourceRow[] {
  const parsed = JSON.parse(raw || "[]") as WindowsProcessInfo[] | WindowsProcessInfo;
  const processInfos = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcessResourceRow[] = [];

  for (const info of processInfos) {
    const pid = toNumber(info.ProcessId);
    const ppid = toNumber(info.ParentProcessId);
    const kernelModeTime = toNumber(info.KernelModeTime) ?? 0;
    const userModeTime = toNumber(info.UserModeTime) ?? 0;
    const workingSetSize = toNumber(info.WorkingSetSize) ?? 0;
    if (pid === null || ppid === null) {
      continue;
    }

    rows.push({
      cpuTimeMs: Math.max(Math.round((kernelModeTime + userModeTime) / 10_000), 0),
      pid,
      ppid,
      rssBytes: Math.max(Math.round(workingSetSize), 0),
    });
  }

  return rows;
}

async function readWindowsProcessResourceRows(): Promise<ProcessResourceRow[]> {
  const script = [
    "Get-CimInstance Win32_Process",
    "| Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize",
    "| ConvertTo-Json -Compress",
  ].join(" ");
  const result = await execa(getWindowsPowerShellCommand(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    reject: true,
  });

  return parseWindowsProcessRows(result.stdout);
}

export async function readProcessResourceSample(
  previousSample: ProcessResourceSample | null = null,
  rootPids: Iterable<number> = [],
): Promise<ProcessResourceSample> {
  const sampledAtMs = Date.now();
  const rows = process.platform === "win32"
    ? await readWindowsProcessResourceRows()
    : await readUnixProcessResourceRows();

  const sample: ProcessResourceSample = {
    rows,
    sampledAtMs,
  };

  const previousMemorySampledAtMs = previousSample?.memorySampledAtMs ?? 0;
  if (
    previousSample?.memoryBytesByPid &&
    previousMemorySampledAtMs > 0 &&
    sampledAtMs - previousMemorySampledAtMs < MEMORY_REFRESH_INTERVAL_MS
  ) {
    sample.memoryBytesByPid = previousSample.memoryBytesByPid;
    sample.memorySampledAtMs = previousMemorySampledAtMs;
    return sample;
  }

  sample.memoryBytesByPid = await readBestProcessMemoryBytesByPid(rows, rootPids);
  sample.memorySampledAtMs = sampledAtMs;
  return sample;
}

async function readBestProcessMemoryBytesByPid(
  rows: ProcessResourceRow[],
  rootPids: Iterable<number>,
): Promise<Map<number, number>> {
  const rowsByPid = indexRowsByPid(rows);
  const childrenByParent = getChildrenByParent(rows);
  const candidatePids = new Set<number>();

  for (const rootPid of rootPids) {
    for (const pid of collectTreePids(rowsByPid, childrenByParent, rootPid)) {
      candidatePids.add(pid);
    }
  }

  const memoryBytesByPid = new Map<number, number>();
  if (process.platform === "linux") {
    await Promise.all(
      [...candidatePids].map(async (pid) => {
        const bytes = await readLinuxPssBytes(pid);
        if (bytes !== null) {
          memoryBytesByPid.set(pid, bytes);
        }
      }),
    );
  }

  return memoryBytesByPid;
}

async function readLinuxPssBytes(pid: number): Promise<number | null> {
  try {
    return parseLinuxSmapsRollupPss(await readFile(`/proc/${pid}/smaps_rollup`, "utf8"));
  } catch {
    return null;
  }
}

export async function readProcessTreeResourceMetrics(
  rootPids: Iterable<number>,
  previousSample: ProcessResourceSample | null = null,
): Promise<ProcessTreeResourceMetricsResult> {
  const requestedPids = [...new Set(rootPids)].filter((pid) => Number.isFinite(pid) && pid > 0);
  const sample = await readProcessResourceSample(previousSample, requestedPids);
  if (requestedPids.length === 0) {
    return { metricsByPid: new Map(), sample };
  }

  const elapsedMs = previousSample ? sample.sampledAtMs - previousSample.sampledAtMs : null;
  return {
    metricsByPid: collectProcessTreeResourceMetrics(
      sample.rows,
      requestedPids,
      previousSample?.rows ?? [],
      elapsedMs,
      {
        memoryBytesByPid: sample.memoryBytesByPid,
      },
    ),
    sample,
  };
}
