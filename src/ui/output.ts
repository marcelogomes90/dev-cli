import { stat } from "node:fs/promises";
import pc from "picocolors";
import Table from "cli-table3";
import type { ProjectConfig } from "../core/config";
import type { ManagedServiceState, SupervisorResponse, SupervisorState } from "../core/supervisor";
import { formatBytes } from "./bytes";

export const STATUS_TABLE_HEAD = ["SERVICE", "GROUP", "STATUS", "BRANCH"];
export const STATUS_LIVE_TABLE_HEAD = ["SERVICE", "GROUP", "STATUS", "BRANCH", "PID", "UPTIME", "MEM", "CPU", "LOG"];

export interface StatusTableData {
  head: string[];
  rows: string[][];
  summary: string;
}

export function printInfo(message: string): void {
  console.log(pc.cyan(message));
}

export function printSuccess(message: string): void {
  console.log(pc.green(message));
}

export function printWarning(message: string): void {
  console.log(pc.yellow(message));
}

export function printError(message: string): void {
  console.error(pc.red(message));
}

export function formatSupervisorResponseSummary(
  project: string,
  action: string,
  response: SupervisorResponse,
): string {
  const results = response.results ?? [];
  if (results.length === 0) {
    return `${project}: ${response.message ?? action}.`;
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    const first = failed[0];
    return `${project}: ${results.length - failed.length}/${results.length} ${action}; ${first.service}: ${first.message}`;
  }

  return `${project}: ${results.length}/${results.length} ${action}.`;
}

export function renderTable(head: string[], rows: string[][]): void {
  const table = new Table({ head });
  for (const row of rows) {
    table.push(row);
  }
  console.log(table.toString());
}

function colorStatus(status: ManagedServiceState["status"] | "stopped"): string {
  switch (status) {
    case "running":
      return pc.green(status);
    case "failed":
      return pc.red(status);
    case "installing":
    case "restarting":
    case "starting":
    case "stopping":
      return pc.yellow(status);
    default:
      return pc.gray(status);
  }
}

function formatRelativeAge(value: string | null, now = Date.now()): string {
  if (!value) {
    return "--";
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "--";
  }

  const seconds = Math.max(Math.floor((now - parsed) / 1000), 0);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}

function formatServiceUptime(service: ManagedServiceState, now: number): string {
  return service.status === "running" ? `up ${formatRelativeAge(service.lastStartedAt, now)}` : "--";
}

function formatServiceMemory(service: ManagedServiceState): string {
  return service.memoryBytes === null || service.memoryBytes === undefined
    ? "--"
    : formatBytes(service.memoryBytes);
}

function formatServiceCpu(service: ManagedServiceState): string {
  return service.cpuPercent === null || service.cpuPercent === undefined
    ? "--"
    : `${Math.round(service.cpuPercent)}%`;
}

async function formatLogSize(pathname: string): Promise<string> {
  try {
    const info = await stat(pathname);
    return formatBytes(info.size, { largePrecision: 0 });
  } catch {
    return "--";
  }
}

function buildStatusSummary(project: string, source: "config" | "live supervisor", services: ManagedServiceState[]): string {
  const running = services.filter((service) => service.status === "running").length;
  const failed = services.filter((service) => service.status === "failed").length;
  const failedText = failed > 0 ? `, ${failed} failed` : "";
  return `${project}: ${running}/${services.length} services running${failedText} (${source})`;
}

export function buildStatusRowsFromConfig(config: ProjectConfig): string[][] {
  const rows: string[][] = [];

  for (const [groupName, group] of Object.entries(config.groups)) {
    for (const serviceName of group.services) {
      rows.push([serviceName, groupName, colorStatus("stopped"), "-"]);
    }
  }

  return rows;
}

export function buildStatusRowsFromState(state: SupervisorState): string[][] {
  const rows: string[][] = [];

  for (const [groupName, serviceNames] of Object.entries(state.groups)) {
    for (const serviceName of serviceNames) {
      const service = state.services[serviceName];
      if (!service) {
        continue;
      }

      rows.push([
        service.service,
        groupName,
        colorStatus(service.status),
        service.isGit ? service.branch : "-",
      ]);
    }
  }

  return rows;
}

export function buildStatusTableFromConfig(config: ProjectConfig): StatusTableData {
  const services = Object.values(config.services).map((service) => ({
    branch: "-",
    command: service.command,
    cpuPercent: null,
    cwd: service.cwd,
    exitCode: null,
    group: service.group,
    installCommand: service.installCommand,
    isGit: false,
    lastStartedAt: null,
    lastStoppedAt: null,
    logPath: "",
    memoryBytes: null,
    pid: null,
    service: service.name,
    status: "stopped" as const,
  }));

  return {
    head: STATUS_TABLE_HEAD,
    rows: buildStatusRowsFromConfig(config),
    summary: buildStatusSummary(config.project, "config", services),
  };
}

export async function buildStatusTableFromState(state: SupervisorState): Promise<StatusTableData> {
  const rows: string[][] = [];
  const now = Date.now();

  for (const [groupName, serviceNames] of Object.entries(state.groups)) {
    for (const serviceName of serviceNames) {
      const service = state.services[serviceName];
      if (!service) {
        continue;
      }

      rows.push([
        service.service,
        groupName,
        colorStatus(service.status),
        service.isGit ? service.branch : "-",
        service.pid ? String(service.pid) : "-",
        formatServiceUptime(service, now),
        formatServiceMemory(service),
        formatServiceCpu(service),
        await formatLogSize(service.logPath),
      ]);
    }
  }

  return {
    head: STATUS_LIVE_TABLE_HEAD,
    rows,
    summary: buildStatusSummary(state.project, "live supervisor", Object.values(state.services)),
  };
}
