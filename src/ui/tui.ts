import os from "node:os";
import { open as openFile, stat } from "node:fs/promises";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import blessed from "blessed";
import type { ProjectConfig } from "../core/config";
import {
  checkoutSupervisorBranch,
  controlSupervisor,
  pullSupervisorBranch,
  readSupervisorState,
} from "../core/supervisor";
import type { ManagedServiceState, SupervisorResponse, SupervisorState } from "../core/supervisor";
import { getErrorMessage } from "../utils/errors";

type UiMode = "branchPrompt" | "navigate";
type MessageTone = "error" | "info" | "success" | "warning";

interface FooterMessage {
  text: string;
  tone: MessageTone;
}

interface ServiceRenderResult {
  content: string;
  failedCount: number;
  headerContent: string;
  runningCount: number;
  serviceNames: string[];
  selectedLine: number;
  totalServices: number;
}

interface LogCache {
  content: string;
  mtimeMs: number;
  pathname: string;
  size: number;
}

export interface SupervisorPaneLayout {
  bodyHeight: number;
  logHeight: number;
  logLeft: number;
  logTop: number;
  logWidth: number;
  servicesHeight: number;
  servicesTop: number;
  servicesWidth: number;
}

interface CpuSnapshot {
  idle: number;
  total: number;
}

interface ResourceMetrics {
  cpuPercent: number | null;
  ramTotalBytes: number | null;
  ramUsedBytes: number | null;
}

export interface LogViewerCommand {
  args: string[];
  command: string;
}

export interface TerminalLaunchCommand {
  args: string[];
  command: string;
  cwd: string;
  label: string;
}

interface TerminalLaunchOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  windowTitle?: string;
}

interface LogViewerProgram {
  disableMouse(): void;
  enableMouse(): void;
  input: {
    pause(): void;
    resume(): void;
    setRawMode?: (mode: boolean) => void;
  };
}

interface LogViewerScreen {
  alloc(): void;
  enter?: () => void;
  leave?: () => void;
  program: LogViewerProgram;
  render(): void;
}

type SpawnSyncLike = (
  command: string,
  args: string[],
  options: { stdio: "inherit" },
) => { error?: NodeJS.ErrnoException; status: number | null };

type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; detached: true; stdio: "ignore" },
) => ChildProcess;

const LOG_TAIL_LINES = 320;
const LOG_TAIL_READ_BYTES = 192 * 1024;
const MAX_INCREMENTAL_READ_BYTES = 128 * 1024;
const HEADER_HEIGHT = 4;
const SERVICES_MIN_HEIGHT = 6;
const SERVICES_MAX_HEIGHT = 12;
const METRICS_REFRESH_MS = 1_000;
const SCREEN_POLL_MS = 250;
const FOOTER_HEIGHT = 4;
const UI_THEME = {
  accent: "cyan",
  border: "gray",
  danger: "red",
  logAccent: "magenta",
  muted: "gray",
  steady: "green",
  tableHeader: "yellow",
  text: "white",
  warning: "yellow",
} as const;
const LOG_VIEWER_SCRIPT = String.raw`
const fs = require("node:fs");

const logPath = process.argv[1];
const stdin = process.stdin;
const stdout = process.stdout;

let content;
try {
  content = fs.readFileSync(logPath, "utf8");
} catch {
  content = "(log file not found)\n";
}

if (!stdin.isTTY || !stdout.isTTY) {
  stdout.write(content);
  process.exit(0);
}

const lines = content.replace(/\r\n/g, "\n").split("\n");
let cleanedUp = false;
let pagerMode = false;
let top = 0;

function terminalRows() {
  return Math.max(1, stdout.rows || 24);
}

function rows() {
  return Math.max(1, terminalRows() - 1);
}

function maxTop() {
  return Math.max(0, lines.length - rows());
}

function render() {
  top = Math.max(0, Math.min(top, maxTop()));
  const r = rows();
  stdout.write("\x1b[H");
  for (let i = 0; i < r; i++) {
    stdout.write((lines[top + i] ?? "") + "\x1b[K");
    if (i < r - 1) stdout.write("\n");
  }
  stdout.write("\x1b[" + (r + 1) + ";1H\x1b[2m--- press v to return ---\x1b[0m\x1b[K");
}

function enterPagerMode(offset) {
  pagerMode = true;
  stdout.write("\x1b[?1049h\x1b[?1007h\x1b[?25l");
  stdout.on("resize", render);
  top = Math.max(0, Math.min(maxTop() + offset, maxTop()));
  render();
}

function scrollPager(offset) {
  top = Math.max(0, Math.min(top + offset, maxTop()));
  render();
}

function scrollOrEnterPager(offset) {
  if (!pagerMode) {
    enterPagerMode(offset);
    return;
  }

  scrollPager(offset);
}

function clearVisibleScreenPreservingScrollback() {
  stdout.write("\n".repeat(terminalRows()));
  stdout.write("\x1b[2J\x1b[H");
}

function cleanup() {
  if (cleanedUp) {
    return;
  }

  cleanedUp = true;
  if (pagerMode) {
    stdout.write("\x1b[?1007l\x1b[?1049l");
  }
  clearVisibleScreenPreservingScrollback();
  stdout.write("\x1b[?25h\x1b[0m");
}

function finish() {
  cleanup();
  process.exit(0);
}

process.on("exit", cleanup);

stdout.write("\x1b[?25l\x1b[0m");
clearVisibleScreenPreservingScrollback();
stdout.write(content);
if (content.length > 0 && !content.endsWith("\n")) {
  stdout.write("\n");
}
stdout.write("\x1b[2m--- press v to return ---\x1b[0m");

stdin.setRawMode(true);
stdin.resume();
stdin.on("data", (chunk) => {
  const input = chunk.toString("utf8");
  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);
    if (rest.startsWith("\x1b[A") || rest.startsWith("\x1bOA")) {
      scrollOrEnterPager(-1);
      i += 3; continue;
    }
    if (rest.startsWith("\x1b[B") || rest.startsWith("\x1bOB")) {
      scrollOrEnterPager(1);
      i += 3; continue;
    }
    if (rest.startsWith("\x1b[5~")) {
      scrollOrEnterPager(-rows());
      i += 4; continue;
    }
    if (rest.startsWith("\x1b[6~")) {
      scrollOrEnterPager(rows());
      i += 4; continue;
    }
    if (rest.startsWith("\x1b[1~") || rest.startsWith("\x1bOH")) {
      if (!pagerMode) enterPagerMode(-maxTop());
      else { top = 0; render(); }
      i += rest.startsWith("\x1b[1~") ? 4 : 3; continue;
    }
    if (rest.startsWith("\x1b[4~") || rest.startsWith("\x1bOF")) {
      if (!pagerMode) enterPagerMode(0);
      else { top = maxTop(); render(); }
      i += rest.startsWith("\x1b[4~") ? 4 : 3; continue;
    }
    if (rest[0] === "\x1b") {
      i += 1; continue;
    }
    if (input[i] === "v" || input[i] === "q") finish();
    if (input[i] === "\x03") finish();
    i += 1;
  }
});
if (pagerMode) stdout.on("resize", render);
`;
const execFileAsync = promisify(execFile);

function fg(color: string, value: string): string {
  return `{${color}-fg}${value}{/${color}-fg}`;
}

function muted(value: string): string {
  return fg(UI_THEME.muted, value);
}

function bold(value: string): string {
  return `{bold}${value}{/bold}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value.padEnd(max, " ");
  }

  return `${value.slice(0, Math.max(max - 1, 0))}…`;
}

function takeTailLines(value: string, maxLines: number): string {
  const lines = value.split("\n");
  return lines.slice(-maxLines).join("\n");
}

function toneTag(tone: MessageTone): string {
  switch (tone) {
    case "success":
      return "green-fg";
    case "warning":
      return "yellow-fg";
    case "error":
      return "red-fg";
    default:
      return "cyan-fg";
  }
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

function formatCompactBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = Math.max(value, 0);
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : current >= 10 ? 0 : 1;
  return `${current.toFixed(precision)}${units[unitIndex]}`;
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

function formatServiceUptime(service: ManagedServiceState, width: number, now: number): string {
  return truncate(getServiceAgeLabel(service, now), width);
}

function formatServiceLogSize(logSize: number | undefined, width: number): string {
  return truncate(logSize === undefined ? "--" : formatCompactBytes(logSize), width);
}

export function getSupervisorPaneLayout(screenWidth: number, screenHeight = 32): SupervisorPaneLayout {
  const width = Math.max(Math.floor(screenWidth), 40);
  const height = Math.max(Math.floor(screenHeight), HEADER_HEIGHT + FOOTER_HEIGHT + 2);
  const bodyHeight = getBodyHeight(height);
  const logMinimumHeight = bodyHeight >= 10 ? 5 : 1;
  const preferredServicesHeight = Math.round(bodyHeight * 0.34);
  const servicesHeight = Math.min(
    Math.max(preferredServicesHeight, SERVICES_MIN_HEIGHT),
    SERVICES_MAX_HEIGHT,
    Math.max(bodyHeight - logMinimumHeight, 1),
  );
  const logHeight = Math.max(bodyHeight - servicesHeight, 1);

  return {
    bodyHeight,
    logHeight,
    logLeft: 0,
    logTop: HEADER_HEIGHT + servicesHeight,
    logWidth: width,
    servicesHeight,
    servicesTop: HEADER_HEIGHT,
    servicesWidth: width,
  };
}

function getServicesInnerWidth(screenWidth: number): number {
  return Math.max(Math.max(Math.floor(screenWidth), 40) - 2, 36);
}

function buildServiceContent(
  state: SupervisorState,
  selectedService: string | null,
  screenWidth: number,
  logSizes: ReadonlyMap<string, LogCache> = new Map(),
): ServiceRenderResult {
  const innerWidth = getServicesInnerWidth(screenWidth);
  const markerWidth = 2;
  const compact = innerWidth < 68;
  const showGroup = innerWidth >= 104;
  const statusWidth = compact ? 10 : 12;
  const groupWidth = showGroup ? 10 : 0;
  const pidWidth = innerWidth >= 104 ? 7 : 6;
  const uptimeWidth = innerWidth >= 104 ? 9 : 8;
  const logWidth = innerWidth >= 104 ? 7 : 6;
  const compactBranchWidth = Math.min(Math.max(Math.floor(innerWidth * 0.24), 10), 18);
  const compactServiceWidth = Math.max(innerWidth - markerWidth - statusWidth - compactBranchWidth - 2, 12);
  const metadataWidth = statusWidth + groupWidth + pidWidth + uptimeWidth + logWidth;
  const separatorWidth = showGroup ? 6 : 5;
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
      ? `${" ".repeat(markerWidth)}${truncate("SERVICE", serviceWidth)} ${truncate("STATUS", statusWidth)} ${truncate("GROUP", groupWidth)} ${truncate("BRANCH", branchWidth)} ${truncate("PID", pidWidth)} ${truncate("UPTIME", uptimeWidth)} ${truncate("LOG", logWidth)}`
      : `${" ".repeat(markerWidth)}${truncate("SERVICE", serviceWidth)} ${truncate("STATUS", statusWidth)} ${truncate("BRANCH", branchWidth)} ${truncate("PID", pidWidth)} ${truncate("UPTIME", uptimeWidth)} ${truncate("LOG", logWidth)}`;
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
      const logSize = fg(rowColor, formatServiceLogSize(logSizes.get(service.service)?.size, logWidth));

      serviceLineByName.set(service.service, lines.length);
      serviceNames.push(service.service);
      lines.push(
        compact
          ? `${marker}${name} ${status} ${branch}`
          : showGroup
            ? `${marker}${name} ${status} ${group} ${branch} ${pid} ${uptime} ${logSize}`
            : `${marker}${name} ${status} ${branch} ${pid} ${uptime} ${logSize}`,
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

async function readLogTail(
  pathname: string,
  cache: LogCache | null,
  maxLines = LOG_TAIL_LINES,
): Promise<LogCache> {
  try {
    const info = await stat(pathname);
    if (
      cache &&
      cache.pathname === pathname &&
      cache.size === info.size &&
      cache.mtimeMs === info.mtimeMs
    ) {
      return cache;
    }

    if (
      cache &&
      cache.pathname === pathname &&
      info.size > cache.size &&
      info.size - cache.size <= MAX_INCREMENTAL_READ_BYTES
    ) {
      const handle = await openFile(pathname, "r");
      try {
        const length = info.size - cache.size;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, cache.size);
        return {
          content: takeTailLines(`${cache.content}${buffer.toString("utf8")}`, maxLines),
          mtimeMs: info.mtimeMs,
          pathname,
          size: info.size,
        };
      } finally {
        await handle.close();
      }
    }

    const start = Math.max(info.size - LOG_TAIL_READ_BYTES, 0);
    const length = info.size - start;
    const handle = await openFile(pathname, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return {
        content: takeTailLines(buffer.toString("utf8"), maxLines),
        mtimeMs: info.mtimeMs,
        pathname,
        size: info.size,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return {
      content: "",
      mtimeMs: 0,
      pathname,
      size: 0,
    };
  }
}

function getBodyHeight(screenHeight: number): number {
  return Math.max(screenHeight - HEADER_HEIGHT - FOOTER_HEIGHT, 1);
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

async function readRamUsage(): Promise<Pick<ResourceMetrics, "ramTotalBytes" | "ramUsedBytes">> {
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

function formatMetricBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = Math.max(value, 0);
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : current >= 10 ? 1 : 1;
  return `${current.toFixed(precision)}${units[unitIndex]}`;
}

function getCpuSnapshot(): CpuSnapshot {
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
      : `RAM ${formatMetricBytes(metrics.ramUsedBytes)}/${formatMetricBytes(metrics.ramTotalBytes)}`;

  return `${cpuText}  ${ramText}`;
}

export function buildHeaderContent(
  project: string,
  serviceSummary: string,
  metricsText: string,
  width: number,
): string {
  const contentWidth = Math.max(width - 2, 10);
  const bodyInset = contentWidth > 18 ? 2 : 1;
  const bodyWidth = Math.max(contentWidth - bodyInset * 2, 8);
  const titleWidth = Math.max(Math.floor(bodyWidth * 0.48), 8);
  const title = truncate(project, titleWidth).trimEnd();
  const metricsWidth = Math.max(bodyWidth - title.length - 2, 0);
  const metrics = metricsWidth > 0 ? truncate(metricsText, metricsWidth).trimEnd() : "";
  const titleSpacer = metrics ? " ".repeat(Math.max(bodyWidth - title.length - metrics.length, 1)) : "";
  const summaryWidth = Math.max(bodyWidth - 8, 8);
  const summary = truncate(serviceSummary, summaryWidth).trimEnd();
  const live = bodyWidth - summary.length > 7 ? fg(UI_THEME.steady, "live") : "";
  const summarySpacer = live ? " ".repeat(Math.max(bodyWidth - summary.length - 4, 1)) : "";

  return [
    `${" ".repeat(bodyInset)}${bold(title)}${titleSpacer}${muted(metrics)}`,
    `${" ".repeat(bodyInset)}${fg(UI_THEME.accent, summary)}${summarySpacer}${live}`,
  ].join("\n");
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildShellCdCommand(cwd: string): string {
  return `cd ${quotePosix(cwd)}`;
}

function detectTerminalIds(env: NodeJS.ProcessEnv): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) {
      ids.push(id);
    }
  };
  const termProgram = env.TERM_PROGRAM?.toLowerCase();
  const bundleId = env.__CFBundleIdentifier?.toLowerCase();
  const term = env.TERM?.toLowerCase();

  if (env.TMUX) {
    add("tmux");
  }

  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET || bundleId === "org.alacritty") {
    add("alacritty");
  }

  if (env.WEZTERM_PANE || env.WEZTERM_EXECUTABLE || termProgram === "wezterm" || bundleId === "com.github.wez.wezterm") {
    add("wezterm");
  }

  if (env.KITTY_WINDOW_ID || env.KITTY_LISTEN_ON || term === "xterm-kitty" || bundleId === "net.kovidgoyal.kitty") {
    add("kitty");
  }

  if (env.GHOSTTY_RESOURCES_DIR || bundleId === "com.mitchellh.ghostty") {
    add("ghostty");
  }

  if (termProgram === "iterm.app" || bundleId === "com.googlecode.iterm2") {
    add("iterm");
  }

  if (termProgram === "apple_terminal" || bundleId === "com.apple.terminal") {
    add("terminal-app");
  }

  if (env.WT_SESSION) {
    add("windows-terminal");
  }

  if (env.KONSOLE_VERSION) {
    add("konsole");
  }

  if (env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE) {
    add("gnome-terminal");
  }

  return ids;
}

function createTerminalLaunchCommand(
  id: string,
  cwd: string,
  platform: NodeJS.Platform,
  windowTitle?: string,
): TerminalLaunchCommand | null {
  switch (id) {
    case "alacritty":
      return platform === "darwin"
        ? { args: ["-na", "Alacritty", "--args", "--working-directory", cwd], command: "open", cwd, label: "Alacritty" }
        : { args: ["--working-directory", cwd], command: "alacritty", cwd, label: "Alacritty" };
    case "ghostty":
      return platform === "darwin"
        ? { args: ["-na", "Ghostty", "--args", `--working-directory=${cwd}`], command: "open", cwd, label: "Ghostty" }
        : { args: [`--working-directory=${cwd}`], command: "ghostty", cwd, label: "Ghostty" };
    case "gnome-terminal":
      return { args: ["--working-directory", cwd], command: "gnome-terminal", cwd, label: "GNOME Terminal" };
    case "iterm": {
      const script = [
        'tell application "iTerm"',
        "  activate",
        "  create window with default profile",
        "  tell current session of current window",
        `    write text ${quoteAppleScriptString(buildShellCdCommand(cwd))}`,
        "  end tell",
        "end tell",
      ].join("\n");
      return { args: ["-e", script], command: "osascript", cwd, label: "iTerm" };
    }
    case "kitty":
      return { args: ["--directory", cwd], command: "kitty", cwd, label: "Kitty" };
    case "konsole":
      return { args: ["--workdir", cwd], command: "konsole", cwd, label: "Konsole" };
    case "terminal-app": {
      const script = [
        'tell application "Terminal"',
        "  activate",
        `  do script ${quoteAppleScriptString(buildShellCdCommand(cwd))}`,
        "end tell",
      ].join("\n");
      return { args: ["-e", script], command: "osascript", cwd, label: "Terminal" };
    }
    case "tmux": {
      const args = ["new-window", "-c", cwd];
      if (windowTitle) {
        args.push("-n", windowTitle);
      }
      return { args, command: "tmux", cwd, label: "tmux" };
    }
    case "wezterm":
      return { args: ["start", "--cwd", cwd], command: "wezterm", cwd, label: "WezTerm" };
    case "windows-cmd":
      return {
        args: ["/c", "start", "", "cmd.exe", "/K", `cd /d ${quoteWindowsCmdArg(cwd)}`],
        command: "cmd.exe",
        cwd,
        label: "Command Prompt",
      };
    case "windows-terminal":
      return { args: ["-w", "new", "-d", cwd], command: "wt", cwd, label: "Windows Terminal" };
    case "xfce4-terminal":
      return { args: ["--working-directory", cwd], command: "xfce4-terminal", cwd, label: "XFCE Terminal" };
    case "x-terminal-emulator":
      return { args: [], command: "x-terminal-emulator", cwd, label: "x-terminal-emulator" };
    case "xterm":
      return { args: [], command: "xterm", cwd, label: "xterm" };
    default:
      return null;
  }
}

export function buildTerminalLaunchCommands(
  cwd: string,
  { env = process.env, platform = process.platform, windowTitle }: TerminalLaunchOptions = {},
): TerminalLaunchCommand[] {
  const ids = detectTerminalIds(env);

  if (platform === "darwin") {
    ids.push("terminal-app", "iterm", "alacritty", "wezterm", "kitty", "ghostty");
  } else if (platform === "win32") {
    ids.push("windows-terminal", "windows-cmd");
  } else {
    ids.push(
      "x-terminal-emulator",
      "gnome-terminal",
      "konsole",
      "xfce4-terminal",
      "alacritty",
      "wezterm",
      "kitty",
      "ghostty",
      "xterm",
    );
  }

  const commands: TerminalLaunchCommand[] = [];
  for (const id of ids) {
    const command = createTerminalLaunchCommand(id, cwd, platform, windowTitle);
    if (
      command &&
      !commands.some((candidate) => candidate.command === command.command && candidate.args.join("\0") === command.args.join("\0"))
    ) {
      commands.push(command);
    }
  }

  return commands;
}

export async function launchTerminal(
  commands: TerminalLaunchCommand[],
  spawnImpl: SpawnLike = spawn,
): Promise<{ command?: TerminalLaunchCommand; error?: NodeJS.ErrnoException; ok: boolean }> {
  let lastError: NodeJS.ErrnoException | undefined;

  for (const command of commands) {
    const result = await new Promise<{ error?: NodeJS.ErrnoException; ok: boolean }>((resolve) => {
      let settled = false;
      const settle = (result: { error?: NodeJS.ErrnoException; ok: boolean }) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      try {
        const child = spawnImpl(command.command, command.args, {
          cwd: command.cwd,
          detached: true,
          stdio: "ignore",
        });
        child.once("spawn", () => {
          child.unref();
          settle({ ok: true });
        });
        child.once("error", (error) => settle({ error: error as NodeJS.ErrnoException, ok: false }));
      } catch (error) {
        settle({ error: error as NodeJS.ErrnoException, ok: false });
      }
    });

    if (result.ok) {
      return { command, ok: true };
    }

    lastError = result.error;
  }

  return { error: lastError, ok: false };
}

export function buildShortcutLine(selected: ManagedServiceState | null, hasLogs = false): string {
  const shortcuts = ["[↑/↓ j/k] Move"];

  if (selected && (selected.status === "stopped" || selected.status === "failed")) {
    shortcuts.push("[a] Start");
  }

  if (selected?.installCommand && (selected.status === "stopped" || selected.status === "failed")) {
    shortcuts.push("[i] Install");
  }

  if (selected && (selected.status === "running" || selected.status === "starting")) {
    shortcuts.push("[s] Stop");
  }

  if (selected?.status === "running") {
    shortcuts.push("[r] Restart");
  }

  if (selected?.isGit && selected.status === "stopped") {
    shortcuts.push("[p] Pull");
  }

  if (selected?.isGit && selected.status === "stopped") {
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

export function buildLogViewerCommand(logPath: string): LogViewerCommand {
  return {
    command: process.execPath,
    args: ["--eval", LOG_VIEWER_SCRIPT, logPath],
  };
}

export function launchExternalLogViewer(
  screen: LogViewerScreen,
  viewerCommand: LogViewerCommand,
  focusTarget: { focus(): void } | null = null,
  spawnSyncImpl: SpawnSyncLike = spawnSync,
): { error?: NodeJS.ErrnoException; status: number | null } {
  const { program } = screen;
  program.input.setRawMode?.(false);
  program.input.pause();
  screen.leave?.();
  program.disableMouse();

  try {
    return spawnSyncImpl(viewerCommand.command, viewerCommand.args, { stdio: "inherit" });
  } finally {
    program.input.setRawMode?.(true);
    program.input.resume();
    if (screen.enter) {
      screen.enter();
    } else {
      screen.alloc();
    }
    program.enableMouse();
    focusTarget?.focus();
    screen.render();
  }
}

function formatActionMessage(response: SupervisorResponse, fallback: string): FooterMessage {
  if (!response.ok) {
    return { text: response.message ?? fallback, tone: "error" };
  }

  if (response.results?.length) {
    const failed = response.results.find((result) => !result.ok);
    if (failed) {
      return { text: `${failed.service}: ${failed.message}`, tone: "error" };
    }

    return {
      text: response.results.length === 1 ? response.results[0].message : response.message ?? fallback,
      tone: "success",
    };
  }

  return { text: response.message ?? fallback, tone: "success" };
}

export async function openSupervisorTui(config: ProjectConfig): Promise<void> {
  await new Promise<void>((resolve) => {
    const initialPaneLayout = getSupervisorPaneLayout(process.stdout.columns ?? 120, process.stdout.rows ?? 32);
    const screen = blessed.screen({
      fullUnicode: true,
      smartCSR: true,
      title: `dev ${config.project}`,
      useBCE: true,
    });

    const header = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: HEADER_HEIGHT,
      border: "line",
      tags: true,
      style: {
        border: { fg: UI_THEME.border },
        fg: UI_THEME.text,
      },
    });

    const servicesFrameBox = blessed.box({
      top: initialPaneLayout.servicesTop,
      left: 0,
      width: initialPaneLayout.servicesWidth,
      height: initialPaneLayout.servicesHeight,
      border: "line",
      label: " Services ",
      tags: true,
      mouse: true,
      style: {
        border: { fg: UI_THEME.accent },
        fg: UI_THEME.text,
      },
    });

    const servicesHeaderBox = blessed.box({
      top: initialPaneLayout.servicesTop + 1,
      left: 1,
      width: Math.max(initialPaneLayout.servicesWidth - 2, 1),
      height: 1,
      tags: true,
      mouse: true,
      style: {
        fg: UI_THEME.tableHeader,
      },
    });

    const servicesBox = blessed.box({
      top: initialPaneLayout.servicesTop + 2,
      left: 1,
      width: Math.max(initialPaneLayout.servicesWidth - 2, 1),
      height: Math.max(initialPaneLayout.servicesHeight - 3, 1),
      tags: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
      },
      style: {
        fg: UI_THEME.text,
        scrollbar: { bg: UI_THEME.accent },
      },
      vi: false,
      wrap: false,
    });

    const logBox = blessed.scrollabletext({
      top: initialPaneLayout.logTop,
      left: initialPaneLayout.logLeft,
      width: initialPaneLayout.logWidth,
      height: initialPaneLayout.logHeight,
      border: "line",
      label: " Logs ",
      tags: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      keys: false,
      scrollbar: {
        ch: " ",
      },
      style: {
        border: { fg: UI_THEME.logAccent },
        fg: UI_THEME.text,
        scrollbar: { bg: UI_THEME.logAccent },
      },
      vi: false,
      wrap: true,
    });

    const footer = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: FOOTER_HEIGHT,
      border: "line",
      tags: true,
      style: {
        border: { fg: UI_THEME.border },
        fg: UI_THEME.text,
      },
    });

    screen.append(header);
    screen.append(servicesFrameBox);
    screen.append(servicesHeaderBox);
    screen.append(servicesBox);
    screen.append(logBox);
    screen.append(footer);

    let state: SupervisorState | null = null;
    let lastServiceRender: ServiceRenderResult | null = null;
    let lastRenderedSelectionKey: string | null = null;
    let mode: UiMode = "navigate";
    let footerMessage: FooterMessage = {
      text: "UI connected. Use a to start services individually.",
      tone: "info",
    };
    let branchInput = "";
    let selectedService: string | null = null;
    let serviceNames: string[] = [];
    let logPinnedToBottom = true;
    let rendering = false;
    let renderPending = false;
    let screenClosed = false;
    let lastMetricsRefreshAt = 0;
    let metricsRefreshPromise: Promise<void> | null = null;
    let logCacheVersion = 0;
    let previousCpuSnapshot: CpuSnapshot | null = null;
    let resourceMetrics: ResourceMetrics = {
      cpuPercent: null,
      ramTotalBytes: null,
      ramUsedBytes: null,
    };
    const logCaches = new Map<string, LogCache>();
    const logRefreshes = new Map<string, Promise<void>>();

    const setFooterMessage = (tone: MessageTone, text: string) => {
      footerMessage = { text, tone };
    };

    const getSelectedService = (): ManagedServiceState | null => {
      if (!state || !selectedService) {
        return null;
      }

      return state.services[selectedService] ?? null;
    };

    const selectedHasLogs = (): boolean => {
      if (!selectedService) {
        return false;
      }

      return (logCaches.get(selectedService)?.size ?? 0) > 0;
    };

    const refreshResourceMetrics = () => {
      const now = Date.now();
      if (now - lastMetricsRefreshAt < METRICS_REFRESH_MS || metricsRefreshPromise) {
        return;
      }

      const currentCpuSnapshot = getCpuSnapshot();
      const cpuPercent = computeCpuPercent(previousCpuSnapshot, currentCpuSnapshot);
      previousCpuSnapshot = currentCpuSnapshot;
      lastMetricsRefreshAt = now;
      metricsRefreshPromise = readRamUsage()
        .then((ramUsage) => {
          resourceMetrics = {
            cpuPercent,
            ...ramUsage,
          };
        })
        .catch(() => {
          resourceMetrics = {
            cpuPercent,
            ramTotalBytes: null,
            ramUsedBytes: null,
          };
        })
        .finally(() => {
          metricsRefreshPromise = null;
          if (!screenClosed) {
            void render();
          }
        });
    };

    const getDisplayLogContent = (
      service: ManagedServiceState | null,
      cache: LogCache | undefined,
    ): string => {
      if (!service) {
        return "No service selected.";
      }

      if (cache && cache.content.length > 0) {
        return cache.content;
      }

      if (
        service.status === "running" ||
        service.status === "restarting" ||
        service.status === "starting" ||
        service.status === "installing"
      ) {
        return "";
      }

      return "No logs yet.";
    };

    const renderFooter = () => {
      const selected = getSelectedService();
      const promptText =
        mode === "branchPrompt" && selected
          ? `Branch for ${selected.service}: ${branchInput || ""}_`
          : footerMessage.text;
      const message = promptText;
      const tone = footerMessage.tone;
      const shortcuts =
        mode === "branchPrompt" ? "" : buildShortcutLine(selected, selectedHasLogs());
      const footerInset = Number(screen.width) > 48 ? 2 : 1;
      const inset = " ".repeat(footerInset);
      const availableWidth = Math.max(Number(screen.width) - 2 - footerInset * 2, 10);
      footer.setContent(
        `${inset}{${toneTag(tone)}}${truncate(message, availableWidth).trimEnd()}{/${toneTag(tone)}}\n${inset}${muted(truncate(shortcuts, availableWidth).trimEnd())}`,
      );
    };

    const applyPaneLayout = () => {
      const paneLayout = getSupervisorPaneLayout(Number(screen.width), Number(screen.height));
      servicesFrameBox.top = paneLayout.servicesTop;
      servicesFrameBox.left = 0;
      servicesFrameBox.width = paneLayout.servicesWidth;
      servicesFrameBox.height = paneLayout.servicesHeight;
      servicesHeaderBox.top = paneLayout.servicesTop + 1;
      servicesHeaderBox.left = 1;
      servicesHeaderBox.width = Math.max(paneLayout.servicesWidth - 2, 1);
      servicesBox.top = paneLayout.servicesTop + 2;
      servicesBox.left = 1;
      servicesBox.width = Math.max(paneLayout.servicesWidth - 2, 1);
      servicesBox.height = Math.max(paneLayout.servicesHeight - 3, 1);
      logBox.top = paneLayout.logTop;
      logBox.left = paneLayout.logLeft;
      logBox.width = paneLayout.logWidth;
      logBox.height = paneLayout.logHeight;
    };

    const renderHeader = (serviceSummary: string) => {
      const metricsText = formatResourceMetrics(resourceMetrics);
      header.setContent(
        buildHeaderContent(config.project, serviceSummary, metricsText, Number(screen.width)),
      );
    };

    const centerInLogBox = (text: string): string => {
      const h = Math.max(1, (Number(logBox.height) || 10) - 2);
      const w = Math.max(1, (Number(logBox.width) || 20) - 2);
      const vertPad = Math.max(0, Math.floor((h - 1) / 2));
      const horizPad = Math.max(0, Math.floor((w - text.length) / 2));
      return "\n".repeat(vertPad) + " ".repeat(horizPad) + muted(text);
    };

    const applyLogContent = (serviceName: string | null) => {
      if (!serviceName || !state?.services[serviceName]) {
        logBox.setLabel(" Logs ");
        logBox.setContent(centerInLogBox("No service selected."));
        return;
      }

      const service = state.services[serviceName];
      const cached = logCaches.get(serviceName);
      const content = getDisplayLogContent(service, cached);
      const follow = logPinnedToBottom ? " follow" : " paused";
      const label = ` Logs: ${service.service} / ${service.status}${follow} `;

      logBox.setLabel(label);
      logBox.setContent(content === "No logs yet." ? centerInLogBox("No logs yet.") : content);

      const contentLines = content.split("\n").length;
      const boxVisibleLines = Math.max(1, (Number(logBox.height) || 10) - 2);

      if (contentLines <= boxVisibleLines) {
        logBox.setScrollPerc(0);
      } else if (logPinnedToBottom) {
        logBox.setScrollPerc(100);
      }
    };

    const refreshLogCache = (serviceName: string) => {
      if (!state?.services[serviceName] || logRefreshes.has(serviceName)) {
        return;
      }

      const service = state.services[serviceName];
      const previousCache = logCaches.get(serviceName) ?? null;
      const refresh = readLogTail(service.logPath, previousCache, LOG_TAIL_LINES)
        .then((cache) => {
          const cacheChanged = cache !== previousCache;
          logCaches.set(serviceName, cache);
          if (cacheChanged) {
            logCacheVersion += 1;
          }
          if (cacheChanged && state) {
            applyServiceRender(buildServiceContent(state, selectedService, Number(screen.width), logCaches));
            lastRenderedSelectionKey = [
              state.updatedAt,
              selectedService ?? "-",
              Number(screen.width),
              Number(screen.height),
              logCacheVersion,
            ].join(":");
          }
          if (selectedService === serviceName) {
            applyLogContent(serviceName);
            renderFooter();
            screen.render();
          }
        })
        .finally(() => {
          logRefreshes.delete(serviceName);
        });

      logRefreshes.set(serviceName, refresh);
    };

    const warmLogCaches = () => {
      for (const serviceName of serviceNames) {
        refreshLogCache(serviceName);
      }
    };

    const ensureSelectedVisible = (selectedLine: number) => {
      const visibleHeight = Math.max(Number(servicesBox.height) || 1, 1);
      const currentScroll = servicesBox.getScroll();

      if (selectedLine <= currentScroll) {
        servicesBox.setScroll(Math.max(selectedLine - 1, 0));
        return;
      }

      if (selectedLine >= currentScroll + visibleHeight - 1) {
        servicesBox.setScroll(Math.max(selectedLine - visibleHeight + 2, 0));
      }
    };

    const applyServiceRender = (serviceRender: ServiceRenderResult) => {
      lastServiceRender = serviceRender;
      serviceNames = serviceRender.serviceNames;
      const failedText = serviceRender.failedCount > 0 ? ` / ${serviceRender.failedCount} failed` : "";
      servicesFrameBox.setLabel(` Services ${serviceRender.runningCount}/${serviceRender.totalServices} running${failedText} `);
      servicesHeaderBox.setContent(serviceRender.headerContent);
      servicesBox.setContent(serviceRender.content);
      ensureSelectedVisible(serviceRender.selectedLine);
    };

    const render = async () => {
      if (rendering) {
        renderPending = true;
        return;
      }

      rendering = true;
      try {
        applyPaneLayout();
        refreshResourceMetrics();
        state = await readSupervisorState(config.project);
        if (!state) {
          header.show();
          footer.show();
          renderHeader("Supervisor is not running.");
          lastServiceRender = null;
          servicesHeaderBox.setContent("");
          servicesBox.setContent("");
          servicesFrameBox.hide();
          servicesHeaderBox.hide();
          servicesBox.hide();
          logBox.hide();
          logBox.setContent("Supervisor is not running.");
          renderFooter();
          screen.render();
          return;
        }

        const nextSelected =
          selectedService && state.services[selectedService]
            ? selectedService
            : Object.keys(state.services)[0] ?? null;
        const selectedChanged = nextSelected !== selectedService;
        selectedService = nextSelected;

        const serviceRenderKey = [
          state.updatedAt,
          selectedService ?? "-",
          Number(screen.width),
          Number(screen.height),
          logCacheVersion,
        ].join(":");
        let currentServiceRender = lastServiceRender;
        if (serviceRenderKey !== lastRenderedSelectionKey || !currentServiceRender) {
          currentServiceRender = buildServiceContent(state, selectedService, Number(screen.width), logCaches);
          applyServiceRender(currentServiceRender);
          lastRenderedSelectionKey = serviceRenderKey;
        }

        const failedSummary = currentServiceRender.failedCount > 0 ? ` - ${currentServiceRender.failedCount} failed` : "";
        const serviceSummary = `${currentServiceRender.runningCount}/${currentServiceRender.totalServices} running${failedSummary}`;
        renderHeader(serviceSummary);

        const selected = getSelectedService();
        if (!selected) {
          applyLogContent(null);
        } else {
          if (selectedChanged) {
            logPinnedToBottom = true;
          }

          applyLogContent(selected.service);
        }

        header.show();
        footer.show();
        servicesFrameBox.show();
        servicesHeaderBox.show();
        servicesBox.show();
        logBox.show();

        warmLogCaches();
        renderFooter();
        screen.render();
      } finally {
        rendering = false;
        if (renderPending) {
          renderPending = false;
          void render();
        }
      }
    };

    const moveSelection = (direction: 1 | -1) => {
      if (mode !== "navigate" || serviceNames.length === 0) {
        return;
      }

      const currentIndex = Math.max(serviceNames.indexOf(selectedService ?? ""), 0);
      const nextIndex = Math.min(Math.max(currentIndex + direction, 0), serviceNames.length - 1);
      selectedService = serviceNames[nextIndex] ?? selectedService;
      if (state) {
        applyServiceRender(buildServiceContent(state, selectedService, Number(screen.width), logCaches));
        applyLogContent(selectedService);
        if (selectedService) {
          refreshLogCache(selectedService);
        }
        renderFooter();
        screen.render();
      }
      void render();
    };

    const startBranchPrompt = () => {
      const selected = getSelectedService();
      if (!selected?.isGit) {
        setFooterMessage("warning", "Selected service is not a git repository.");
        void render();
        return;
      }

      if (selected.status !== "stopped") {
        setFooterMessage("warning", `${selected.service} cannot switch branch from status ${selected.status}.`);
        void render();
        return;
      }

      mode = "branchPrompt";
      branchInput = "";
      setFooterMessage("info", `Branch for ${selected.service}:`);
      renderFooter();
      screen.render();
    };

    const pullSelectedBranch = async () => {
      const selected = getSelectedService();
      if (!selected) {
        setFooterMessage("warning", "No service selected.");
        void render();
        return;
      }

      if (!selected.isGit) {
        setFooterMessage("warning", `${selected.service} is not a git repository.`);
        void render();
        return;
      }

      if (selected.status !== "stopped") {
        setFooterMessage("warning", `${selected.service} cannot pull from status ${selected.status}.`);
        void render();
        return;
      }

      await runAction(async () => {
        const response = await pullSupervisorBranch(config, selected.service);
        const selectedResult = response.results?.find((result) => result.service === selected.service);
        if (selectedResult?.ok && state?.services[selected.service]) {
          state.services[selected.service].isGit = true;
          state.services[selected.service].branch = selected.branch;
          state.updatedAt = new Date().toISOString();
        }
        return response;
      }, `Pull ${selected.service} failed.`);
    };

    const cancelBranchPrompt = () => {
      branchInput = "";
      mode = "navigate";
      setFooterMessage("info", "Branch change cancelled.");
      renderFooter();
      screen.render();
    };

    const openLogInPager = () => {
      const service = getSelectedService();
      if (!service) {
        setFooterMessage("warning", "No service selected.");
        void render();
        return;
      }

      const viewerCommand = buildLogViewerCommand(service.logPath);
      const result = launchExternalLogViewer(screen as unknown as LogViewerScreen, viewerCommand, servicesBox);

      if (result.error) {
        setFooterMessage("error", `Unable to open logs for ${service.service}: ${getErrorMessage(result.error)}`);
      }

      void render();
    };

    const openTerminalForSelectedService = async () => {
      const service = getSelectedService();
      if (!service) {
        setFooterMessage("warning", "No service selected.");
        void render();
        return;
      }

      const result = await launchTerminal(buildTerminalLaunchCommands(service.cwd, { windowTitle: service.service }));
      if (!result.ok) {
        setFooterMessage(
          "error",
          `Unable to open terminal for ${service.service}: ${result.error ? getErrorMessage(result.error) : "no terminal command available"}`,
        );
        void render();
        return;
      }

      setFooterMessage("info", `Opening terminal for ${service.service} in ${service.cwd}.`);
      void render();
    };

    const scrollLogs = (offset: number) => {
      logBox.scroll(offset);
      logPinnedToBottom = logBox.getScrollPerc() >= 98;
      screen.render();
    };

    const runAction = async (action: () => Promise<SupervisorResponse>, fallback: string) => {
      try {
        const response = await action();
        const message = formatActionMessage(response, fallback);
        setFooterMessage(message.tone, message.text);
      } catch (error) {
        setFooterMessage("error", getErrorMessage(error));
      }

      void render();
    };

    const runSelectedServiceAction = async (
      action: "clear-logs" | "install" | "restart" | "start" | "stop",
    ) => {
      const selected = getSelectedService();
      if (!selected) {
        setFooterMessage("warning", "No service selected.");
        void render();
        return;
      }

      if (action === "start" && selected.status !== "stopped" && selected.status !== "failed") {
        setFooterMessage("warning", `${selected.service} cannot be started from status ${selected.status}.`);
        void render();
        return;
      }

      if (action === "install" && !selected.installCommand) {
        setFooterMessage("warning", `${selected.service} has no install command configured.`);
        void render();
        return;
      }

      if (action === "install" && selected.status !== "stopped" && selected.status !== "failed") {
        setFooterMessage("warning", `${selected.service} cannot install from status ${selected.status}.`);
        void render();
        return;
      }

      if (action === "restart" && selected.status !== "running") {
        setFooterMessage("warning", `${selected.service} cannot restart from status ${selected.status}.`);
        void render();
        return;
      }

      if (action === "stop" && selected.status !== "running" && selected.status !== "starting") {
        setFooterMessage("warning", `${selected.service} cannot be stopped from status ${selected.status}.`);
        void render();
        return;
      }

      if (action === "clear-logs" && !selectedHasLogs()) {
        setFooterMessage("warning", `${selected.service} has no logs to clear.`);
        void render();
        return;
      }

      const prefix =
        action === "start"
          ? `Start ${selected.service}`
          : action === "restart"
            ? `Restart ${selected.service}`
            : action === "install"
              ? `Install ${selected.service}`
            : action === "clear-logs"
              ? `Clear logs for ${selected.service}`
              : `Stop ${selected.service}`;
      await runAction(async () => {
        const response = await controlSupervisor(config, action, [selected.service]);
        const selectedResult = response.results?.find((result) => result.service === selected.service);
        if (selectedResult?.ok && state?.services[selected.service]) {
          if (action === "start") {
            state.services[selected.service].status = "starting";
          } else if (action === "install") {
            state.services[selected.service].status = "installing";
          } else if (action === "restart") {
            state.services[selected.service].status = "restarting";
          } else if (action === "stop") {
            state.services[selected.service].status = "stopped";
          }
          state.updatedAt = new Date().toISOString();
        }

        if (selectedResult?.ok && (action === "start" || action === "install" || action === "restart")) {
          logCaches.delete(selected.service);
          applyLogContent(selected.service);
          renderFooter();
        }

        if (action === "stop" && selectedResult?.ok) {
          logCaches.delete(selected.service);
          applyLogContent(selected.service);
          renderFooter();
        }

        if (action === "clear-logs" && selectedResult?.ok) {
          const currentPath = state?.services[selected.service]?.logPath ?? selected.logPath;
          logCaches.set(selected.service, {
            content: "",
            mtimeMs: Date.now(),
            pathname: currentPath,
            size: 0,
          });
          applyLogContent(selected.service);
          renderFooter();
        }
        return response;
      }, `${prefix} failed.`);
    };

    const submitBranchPrompt = async () => {
      const selected = getSelectedService();
      const targetBranch = branchInput.trim();

      if (!selected) {
        branchInput = "";
        setFooterMessage("warning", "No service selected.");
        mode = "navigate";
        void render();
        return;
      }

      if (!selected.isGit) {
        branchInput = "";
        setFooterMessage("warning", `${selected.service} is not a git repository.`);
        mode = "navigate";
        void render();
        return;
      }

      if (!targetBranch) {
        setFooterMessage("warning", "Branch name is required.");
        renderFooter();
        screen.render();
        return;
      }

      branchInput = "";
      mode = "navigate";
      await runAction(async () => {
        const response = await checkoutSupervisorBranch(config, selected.service, targetBranch);
        if (response.ok && state?.services[selected.service]) {
          state.services[selected.service].branch = targetBranch;
          state.services[selected.service].isGit = true;
          state.updatedAt = new Date().toISOString();
        }
        return response;
      }, `Checkout ${targetBranch} failed.`);
    };

    const closeScreen = () => {
      screen.destroy();
      resolve();
    };

    servicesFrameBox.on("wheelup", () => moveSelection(-1));
    servicesFrameBox.on("wheeldown", () => moveSelection(1));
    servicesHeaderBox.on("wheelup", () => moveSelection(-1));
    servicesHeaderBox.on("wheeldown", () => moveSelection(1));
    servicesBox.on("wheelup", () => moveSelection(-1));
    servicesBox.on("wheeldown", () => moveSelection(1));
    logBox.on("wheelup", () => {
      scrollLogs(-2);
    });
    logBox.on("wheeldown", () => {
      scrollLogs(2);
    });

    screen.key(["up", "k"], () => {
      if (mode === "navigate") {
        moveSelection(-1);
      }
    });
    screen.key(["down", "j"], () => {
      if (mode === "navigate") {
        moveSelection(1);
      }
    });
    screen.key(["pageup"], () => {
      if (mode !== "branchPrompt") {
        scrollLogs(-12);
      }
    });
    screen.key(["pagedown"], () => {
      if (mode !== "branchPrompt") {
        scrollLogs(12);
      }
    });
    screen.key(["home"], () => {
      if (mode === "branchPrompt") {
        return;
      }
      logPinnedToBottom = false;
      logBox.setScroll(0);
      screen.render();
    });
    screen.key(["end"], () => {
      if (mode === "branchPrompt") {
        return;
      }
      logPinnedToBottom = true;
      logBox.setScrollPerc(100);
      screen.render();
    });
    screen.key(["v"], () => {
      if (mode === "branchPrompt") {
        return;
      }

      openLogInPager();
    });
    screen.key(["d"], () => {
      if (mode === "navigate") {
        startBranchPrompt();
      }
    });
    screen.key(["p"], () => {
      if (mode === "navigate") {
        void pullSelectedBranch();
      }
    });
    screen.key(["a"], () => {
      if (mode === "navigate") {
        void runSelectedServiceAction("start");
      }
    });
    screen.key(["i"], () => {
      if (mode === "navigate") {
        void runSelectedServiceAction("install");
      }
    });
    screen.key(["s"], () => {
      if (mode === "navigate") {
        void runSelectedServiceAction("stop");
      }
    });
    screen.key(["r"], () => {
      if (mode === "navigate") {
        void runSelectedServiceAction("restart");
      }
    });
    screen.key(["c"], () => {
      if (mode === "navigate") {
        void runSelectedServiceAction("clear-logs");
      }
    });
    screen.key(["e"], () => {
      if (mode !== "navigate" || !selectedService) return;

      const service = config.services[selectedService];
      const editor = config.editor ?? "code";

      const child = spawn(editor, [service.cwd], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => {
        const msg =
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `Editor "${editor}" not found. Check your config.`
            : `Failed to open editor: ${err.message}`;
        setFooterMessage("error", msg);
        renderFooter();
        screen.render();
      });
      child.unref();
      setFooterMessage("info", `Opening ${service.cwd} in ${editor}…`);
      renderFooter();
      screen.render();
    });
    screen.key(["t"], () => {
      if (mode === "navigate") {
        void openTerminalForSelectedService();
      }
    });
    screen.key(["enter"], () => {
      if (mode === "branchPrompt") {
        void submitBranchPrompt();
        return;
      }

      if (mode === "navigate") {
        void runSelectedServiceAction("start");
      }
    });
    screen.key(["q"], () => {
      if (mode !== "branchPrompt") {
        closeScreen();
      }
    });
    screen.key(["C-c"], () => closeScreen());
    screen.key(["escape"], () => {
      if (mode === "branchPrompt") {
        cancelBranchPrompt();
        return;
      }

      closeScreen();
    });
    screen.on("keypress", (ch, key) => {
      if (mode !== "branchPrompt") {
        return;
      }

      if (key.name === "backspace") {
        branchInput = branchInput.slice(0, -1);
        renderFooter();
        screen.render();
        return;
      }

      if (key.name === "enter" || key.name === "escape") {
        return;
      }

      if (ch && !key.ctrl && !key.meta) {
        branchInput += ch;
        renderFooter();
        screen.render();
      }
    });
    screen.on("resize", () => {
      void render();
    });

    const interval = setInterval(() => {
      void render();
    }, SCREEN_POLL_MS);

    screen.on("destroy", () => {
      screenClosed = true;
      clearInterval(interval);
    });

    void render();
  });
}
