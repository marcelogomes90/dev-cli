import type { ManagedServiceState, SupervisorState } from "../core/supervisor";
import { formatBytes } from "./bytes";
import type { LogCache } from "./logs";
import { fg, muted, truncate, UI_THEME } from "./theme";

export interface ServiceRenderResult {
  content: string;
  failedCount: number;
  headerContent: string;
  runningCount: number;
  serviceNames: string[];
  selectedLine: number;
  totalServices: number;
}

function colorStatus(status: ManagedServiceState["status"], value: string): string {
  switch (status) {
    case "running":
      return fg(UI_THEME.steady, value);
    case "installing":
    case "restarting":
    case "starting":
    case "stopping":
      return fg(UI_THEME.warning, value);
    case "failed":
      return fg(UI_THEME.danger, value);
    case "stopped":
      return muted(value);
    default:
      return value;
  }
}

function statusDot(status: ManagedServiceState["status"]): string {
  switch (status) {
    case "running":
      return "●";
    case "failed":
      return "!";
    case "stopped":
      return "○";
    default:
      return "●";
  }
}

function formatStatus(status: ManagedServiceState["status"], width: number): string {
  return colorStatus(status, truncate(`${statusDot(status)} ${status.toUpperCase()}`, width));
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

function getServiceAgeLabel(service: ManagedServiceState, now: number): string {
  if (service.status !== "running") {
    return "--";
  }

  return `up ${formatRelativeAge(service.lastStartedAt, now)}`;
}

function formatServicePid(service: ManagedServiceState, width: number): string {
  return truncate(service.pid ? String(service.pid) : "-", width);
}

function formatServiceMemory(service: ManagedServiceState, width: number): string {
  return truncate(
    service.memoryBytes === null || service.memoryBytes === undefined
      ? "--"
      : formatBytes(service.memoryBytes),
    width,
  );
}

function formatServiceCpu(service: ManagedServiceState, width: number): string {
  return truncate(
    service.cpuPercent === null || service.cpuPercent === undefined
      ? "--"
      : `${Math.round(service.cpuPercent)}%`,
    width,
  );
}

function formatServiceUptime(service: ManagedServiceState, width: number, now: number): string {
  return truncate(getServiceAgeLabel(service, now), width);
}

function formatServiceLogSize(logSize: number | undefined, width: number): string {
  return truncate(logSize === undefined ? "--" : formatBytes(logSize, { largePrecision: 0 }), width);
}

function getServicesInnerWidth(screenWidth: number): number {
  return Math.max(Math.max(Math.floor(screenWidth), 40) - 2, 36);
}

export function buildServiceContent(
  state: SupervisorState,
  selectedService: string | null,
  screenWidth: number,
  logSizes: ReadonlyMap<string, LogCache> = new Map(),
): ServiceRenderResult {
  const innerWidth = getServicesInnerWidth(screenWidth);
  const markerWidth = 2;
  const compact = innerWidth < 84;
  const showGroup = innerWidth >= 104;
  const statusWidth = compact ? 10 : 12;
  const groupWidth = showGroup ? 10 : 0;
  const pidWidth = innerWidth >= 104 ? 7 : 6;
  const uptimeWidth = innerWidth >= 104 ? 9 : 8;
  const memoryWidth = innerWidth >= 104 ? 8 : 7;
  const cpuWidth = 5;
  const logWidth = innerWidth >= 104 ? 7 : 6;
  const compactBranchWidth = Math.min(Math.max(Math.floor(innerWidth * 0.24), 10), 18);
  const compactServiceWidth = Math.max(innerWidth - markerWidth - statusWidth - compactBranchWidth - 2, 12);
  const metadataWidth = statusWidth + groupWidth + pidWidth + uptimeWidth + memoryWidth + cpuWidth + logWidth;
  const separatorWidth = showGroup ? 8 : 7;
  const availableWidth = Math.max(
    innerWidth - markerWidth - metadataWidth - separatorWidth,
    26,
  );
  const serviceWidth = compact
    ? compactServiceWidth
    : Math.min(Math.max(Math.floor(availableWidth * 0.38), 16), 24);
  const branchWidth = compact
    ? compactBranchWidth
    : Math.max(availableWidth - serviceWidth, 10);

  const lines: string[] = [];
  const serviceLineByName = new Map<string, number>();
  const serviceNames: string[] = [];
  const now = Date.now();
  let failedCount = 0;
  let runningCount = 0;

  const header = compact
    ? `${" ".repeat(markerWidth)}${truncate("SERVICE", serviceWidth)} ${truncate("STATUS", statusWidth)} ${truncate("BRANCH", branchWidth)}`
    : showGroup
      ? `${" ".repeat(markerWidth)}${truncate("SERVICE", serviceWidth)} ${truncate("STATUS", statusWidth)} ${truncate("GROUP", groupWidth)} ${truncate("BRANCH", branchWidth)} ${truncate("PID", pidWidth)} ${truncate("UPTIME", uptimeWidth)} ${truncate("MEM", memoryWidth)} ${truncate("CPU", cpuWidth)} ${truncate("LOG", logWidth)}`
      : `${" ".repeat(markerWidth)}${truncate("SERVICE", serviceWidth)} ${truncate("STATUS", statusWidth)} ${truncate("BRANCH", branchWidth)} ${truncate("PID", pidWidth)} ${truncate("UPTIME", uptimeWidth)} ${truncate("MEM", memoryWidth)} ${truncate("CPU", cpuWidth)} ${truncate("LOG", logWidth)}`;
  const headerContent = fg(UI_THEME.tableHeader, header);

  for (const [groupName, serviceList] of Object.entries(state.groups)) {
    for (const serviceName of serviceList) {
      const service = state.services[serviceName];
      if (!service) {
        continue;
      }

      const isSelected = service.service === selectedService;
      if (service.status === "running") {
        runningCount += 1;
      }
      if (service.status === "failed") {
        failedCount += 1;
      }

      const rowColor = isSelected ? UI_THEME.accent : UI_THEME.text;
      const marker = isSelected ? fg(UI_THEME.accent, "> ") : "  ";
      const name = fg(rowColor, truncate(service.service, serviceWidth));
      const group = fg(rowColor, truncate(groupName, groupWidth));
      const status = formatStatus(service.status, statusWidth);
      const branch = fg(rowColor, truncate(service.isGit ? service.branch : "-", branchWidth));
      const pid = fg(rowColor, formatServicePid(service, pidWidth));
      const uptime = fg(rowColor, formatServiceUptime(service, uptimeWidth, now));
      const memory = fg(rowColor, formatServiceMemory(service, memoryWidth));
      const cpu = fg(rowColor, formatServiceCpu(service, cpuWidth));
      const logSize = fg(rowColor, formatServiceLogSize(logSizes.get(service.service)?.size, logWidth));

      serviceLineByName.set(service.service, lines.length);
      serviceNames.push(service.service);
      lines.push(
        compact
          ? `${marker}${name} ${status} ${branch}`
          : showGroup
            ? `${marker}${name} ${status} ${group} ${branch} ${pid} ${uptime} ${memory} ${cpu} ${logSize}`
            : `${marker}${name} ${status} ${branch} ${pid} ${uptime} ${memory} ${cpu} ${logSize}`,
      );
    }
  }

  const selectedLine = serviceLineByName.get(selectedService ?? "") ?? 0;

  return {
    content: lines.join("\n"),
    failedCount,
    headerContent,
    runningCount,
    selectedLine,
    serviceNames,
    totalServices: serviceNames.length,
  };
}

export function buildShortcutLine(selected: ManagedServiceState | null, hasLogs = false): string {
  const shortcuts = ["[↑/↓ j/k] Move"];
  const canInstall = selected?.installCommand && (
    selected.status === "stopped" ||
    selected.status === "failed" ||
    selected.status === "running"
  );
  const canUseGit = selected?.isGit && (
    selected.status === "stopped" ||
    selected.status === "failed" ||
    selected.status === "running"
  );

  if (selected && (selected.status === "stopped" || selected.status === "failed")) {
    shortcuts.push("[a] Start");
  }

  if (canInstall) {
    shortcuts.push("[i] Install");
  }

  if (selected && (selected.status === "running" || selected.status === "starting")) {
    shortcuts.push("[s] Stop");
  }

  if (selected?.status === "running") {
    shortcuts.push("[r] Restart");
  }

  if (canUseGit) {
    shortcuts.push("[p] Pull");
  }

  if (canUseGit) {
    shortcuts.push("[d] Branch");
  }

  if (hasLogs) {
    shortcuts.push("[c] Clear logs");
  }

  if (selected) {
    shortcuts.push("[e] Editor", "[t] Terminal");
  }

  shortcuts.push("[v] View logs", "[q] Quit");
  return shortcuts.join(" | ");
}
