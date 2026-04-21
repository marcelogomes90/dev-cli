import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatBytes } from "./bytes";

const execFileAsync = promisify(execFile);

export interface CpuSnapshot {
  idle: number;
  total: number;
}

export interface ResourceMetrics {
  cpuPercent: number | null;
  ramTotalBytes: number | null;
  ramUsedBytes: number | null;
}

export function parseDarwinMemoryUsage(
  vmStatOutput: string,
  totalBytes: number,
): { ramTotalBytes: number; ramUsedBytes: number } | null {
  const pageSizeMatch = vmStatOutput.match(/page size of (\d+) bytes/i);
  if (!pageSizeMatch) {
    return null;
  }

  const pageSize = Number(pageSizeMatch[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return null;
  }

  const readPages = (label: string): number | null => {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = vmStatOutput.match(new RegExp(`${escapedLabel}:\\s+(\\d+)\\.`));
    return match ? Number(match[1]) : null;
  };

  const activePages = readPages("Pages active");
  const wiredPages = readPages("Pages wired down");
  const compressedPages = readPages("Pages occupied by compressor");
  if (activePages === null || wiredPages === null || compressedPages === null) {
    return null;
  }

  const usedPages = activePages + wiredPages + compressedPages;
  const ramUsedBytes = Math.min(usedPages * pageSize, totalBytes);

  return {
    ramTotalBytes: totalBytes,
    ramUsedBytes,
  };
}

export async function readRamUsage(): Promise<Pick<ResourceMetrics, "ramTotalBytes" | "ramUsedBytes">> {
  const totalBytes = os.totalmem();

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("vm_stat");
      const parsed = parseDarwinMemoryUsage(stdout, totalBytes);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Fall back to the generic Node values if vm_stat is unavailable.
    }
  }

  return {
    ramTotalBytes: totalBytes,
    ramUsedBytes: totalBytes - os.freemem(),
  };
}

export function getCpuSnapshot(): CpuSnapshot {
  const totals = os.cpus().reduce(
    (aggregate, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      aggregate.idle += cpu.times.idle;
      aggregate.total += total;
      return aggregate;
    },
    { idle: 0, total: 0 },
  );

  return totals;
}

export function computeCpuPercent(
  previous: CpuSnapshot | null,
  current: CpuSnapshot,
): number | null {
  if (!previous) {
    return null;
  }

  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) {
    return null;
  }

  const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.max(0, Math.min(100, Math.round(usage)));
}

export function formatResourceMetrics(metrics: ResourceMetrics): string {
  const cpuText = metrics.cpuPercent === null ? "CPU --" : `CPU ${metrics.cpuPercent}%`;
  const ramText =
    metrics.ramUsedBytes === null || metrics.ramTotalBytes === null
      ? "RAM --"
      : `RAM ${formatBytes(metrics.ramUsedBytes)}/${formatBytes(metrics.ramTotalBytes)}`;

  return `${cpuText}  ${ramText}`;
}
