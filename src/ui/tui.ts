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
  logLeft: number;
  logWidth: number;
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
  resetMode(...args: string[]): boolean;
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
const METRICS_REFRESH_MS = 1_000;
const SCREEN_POLL_MS = 250;
const FOOTER_HEIGHT = 4;
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
let top = 0;
let pasteMode = false;

function visibleRows() {
  return Math.max(1, (stdout.rows || 24) - 1);
}

function maxTop() {
  return Math.max(0, lines.length - visibleRows());
}

function clampTop() {
  top = Math.max(0, Math.min(top, maxTop()));
}

function render() {
  clampTop();
  const rows = visibleRows();
  stdout.write("\x1b[?25l\x1b[?7l\x1b[2J\x1b[H");

  for (let index = 0; index < rows; index += 1) {
    stdout.write(lines[top + index] ?? "");
    stdout.write("\x1b[K");
    if (index < rows - 1) {
      stdout.write("\n");
    }
  }

  stdout.write("\x1b[" + (rows + 1) + ";1H\x1b[2m--- arrows/page scroll, press v to return ---\x1b[0m\x1b[K");
}

function finish() {
  stdout.write("\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[0m");
  process.exit(0);
}

function scroll(offset) {
  top += offset;
  render();
}

function handleSequence(sequence) {
  switch (sequence) {
    case "\x1b[A":
    case "\x1bOA":
      scroll(-1);
      return true;
    case "\x1b[B":
    case "\x1bOB":
      scroll(1);
      return true;
    case "\x1b[5~":
      scroll(-visibleRows());
      return true;
    case "\x1b[6~":
      scroll(visibleRows());
      return true;
    case "\x1b[H":
    case "\x1b[1~":
    case "\x1bOH":
      top = 0;
      render();
      return true;
    case "\x1b[F":
    case "\x1b[4~":
    case "\x1bOF":
      top = maxTop();
      render();
      return true;
    default:
      return false;
  }
}

function handleInput(chunk) {
  const input = chunk.toString("utf8");
  let index = 0;

  while (index < input.length) {
    if (pasteMode) {
      const end = input.indexOf("\x1b[201~", index);
      if (end === -1) {
        return;
      }

      pasteMode = false;
      index = end + "\x1b[201~".length;
      continue;
    }

    if (input.startsWith("\x1b[200~", index)) {
      pasteMode = true;
      index += "\x1b[200~".length;
      continue;
    }

    const candidates = [
      "\x1b[5~",
      "\x1b[6~",
      "\x1b[1~",
      "\x1b[4~",
      "\x1b[A",
      "\x1b[B",
      "\x1b[H",
      "\x1b[F",
      "\x1bOA",
      "\x1bOB",
      "\x1bOH",
      "\x1bOF",
    ];
    const sequence = candidates.find((candidate) => input.startsWith(candidate, index));
    if (sequence) {
      handleSequence(sequence);
      index += sequence.length;
      continue;
    }

    if (input[index] === "v") {
      finish();
    }

    index += 1;
  }
}

stdin.setRawMode(true);
stdin.resume();
stdin.on("data", handleInput);
stdout.on("resize", render);
process.on("exit", () => {
  stdout.write("\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[0m");
});

stdout.write("\x1b[?2004h");
top = maxTop();
render();
`;
const execFileAsync = promisify(execFile);

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
      return `{green-fg}${value}{/green-fg}`;
    case "installing":
    case "restarting":
    case "starting":
    case "stopping":
      return `{yellow-fg}${value}{/yellow-fg}`;
    case "failed":
    case "stopped":
      return `{red-fg}${value}{/red-fg}`;
    default:
      return value;
  }
}

export function getSupervisorPaneLayout(screenWidth: number): SupervisorPaneLayout {
  const width = Math.max(Math.floor(screenWidth), 40);
  const servicesWidth = Math.min(
    Math.max(Math.floor(width * 0.44), 40),
    Math.max(width - 24, 20),
  );

  return {
    logLeft: servicesWidth,
    logWidth: Math.max(width - servicesWidth, 20),
    servicesWidth,
  };
}

function getServicesInnerWidth(screenWidth: number): number {
  return Math.max(getSupervisorPaneLayout(screenWidth).servicesWidth - 2, 36);
}

function buildServiceContent(
  state: SupervisorState,
  selectedService: string | null,
  screenWidth: number,
): ServiceRenderResult {
  const innerWidth = getServicesInnerWidth(screenWidth);
  const markerWidth = 2;
  const statusWidth = 11;
  const groupWidth = 12;
  const availableWidth = Math.max(innerWidth - markerWidth - groupWidth - statusWidth - 3, 22);
  const serviceWidth = Math.min(Math.max(Math.floor(availableWidth * 0.45), 12), 18);
  const branchWidth = Math.max(availableWidth - serviceWidth, 8);

  const lines: string[] = [];
  const serviceLineByName = new Map<string, number>();
  const serviceNames: string[] = [];
  let runningCount = 0;

  lines.push(
    `${" ".repeat(markerWidth)}${truncate("SERVICE", serviceWidth)} ${truncate("GROUP", groupWidth)} ${truncate("STATUS", statusWidth)} ${truncate("BRANCH", branchWidth)}`,
  );

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
      const marker = isSelected ? "{cyan-fg}>{/cyan-fg} " : "  ";
      const name = isSelected
        ? `{bold}${truncate(service.service, serviceWidth)}{/bold}`
        : truncate(service.service, serviceWidth);
      const group = truncate(groupName, groupWidth);
      const status = colorStatus(service.status, truncate(service.status, statusWidth));
      const branch = truncate(service.isGit ? service.branch : "-", branchWidth);

      serviceLineByName.set(service.service, lines.length);
      serviceNames.push(service.service);
      lines.push(`${marker}${name} ${group} ${status} ${branch}`);
    }
  }

  const selectedLine = serviceLineByName.get(selectedService ?? "") ?? 0;

  return {
    content: lines.join("\n"),
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
  const bodyInset = contentWidth > 12 ? 2 : 1;
  const bodyWidth = Math.max(contentWidth - bodyInset * 2, 8);
  const title = truncate(project, contentWidth).trimEnd();
  const titlePadding = Math.max(Math.floor((contentWidth - title.length) / 2), 0);
  const summaryWidth = Math.min(serviceSummary.length, Math.max(bodyWidth - 12, 8));
  const metricsWidth = Math.max(bodyWidth - summaryWidth - 2, 0);
  const left = truncate(serviceSummary, summaryWidth).trimEnd();
  const right = metricsWidth > 0 ? truncate(metricsText, metricsWidth).trimEnd() : "";
  const spacer = right ? " ".repeat(Math.max(bodyWidth - left.length - right.length, 1)) : "";

  return `${" ".repeat(titlePadding)}{bold}${title}{/bold}\n${" ".repeat(bodyInset)}${left}${spacer}${right}${" ".repeat(bodyInset)}`;
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
  program.resetMode("?1007");

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
    const initialPaneLayout = getSupervisorPaneLayout(process.stdout.columns ?? 120);
    const screen = blessed.screen({
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
    });

    const servicesBox = blessed.box({
      top: HEADER_HEIGHT,
      left: 0,
      width: initialPaneLayout.servicesWidth,
      height: `100%-${HEADER_HEIGHT + FOOTER_HEIGHT}`,
      border: "line",
      label: " Services ",
      tags: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
      },
      style: {
        border: { fg: "cyan" },
        scrollbar: { bg: "cyan" },
      },
      vi: false,
    });

    const logBox = blessed.scrollabletext({
      top: HEADER_HEIGHT,
      left: initialPaneLayout.logLeft,
      width: initialPaneLayout.logWidth,
      height: `100%-${HEADER_HEIGHT + FOOTER_HEIGHT}`,
      border: "line",
      label: " Logs ",
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      keys: false,
      scrollbar: {
        ch: " ",
      },
      style: {
        border: { fg: "yellow" },
        scrollbar: { bg: "yellow" },
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
        border: { fg: "white" },
      },
    });

    screen.append(header);
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
      footer.setContent(
        `{${toneTag(tone)}}${truncate(message, Math.max(Number(screen.width) - 4, 10)).trimEnd()}{/${toneTag(tone)}}\n${truncate(shortcuts, Math.max(Number(screen.width) - 4, 10)).trimEnd()}`,
      );
    };

    const applyPaneLayout = () => {
      const paneLayout = getSupervisorPaneLayout(Number(screen.width));
      servicesBox.width = paneLayout.servicesWidth;
      logBox.left = paneLayout.logLeft;
      logBox.width = paneLayout.logWidth;
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
      return "\n".repeat(vertPad) + " ".repeat(horizPad) + text;
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
      const label = ` Logs: ${service.service} `;

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
      const refresh = readLogTail(service.logPath, logCaches.get(serviceName) ?? null, LOG_TAIL_LINES)
        .then((cache) => {
          logCaches.set(serviceName, cache);
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
      const visibleHeight = Math.max(getBodyHeight(Number(screen.height)) - 2, 1);
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
          servicesBox.setContent("");
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

        const serviceRenderKey = `${state.updatedAt}:${selectedService ?? "-"}`;
        let currentServiceRender = lastServiceRender;
        if (serviceRenderKey !== lastRenderedSelectionKey || !currentServiceRender) {
          currentServiceRender = buildServiceContent(state, selectedService, Number(screen.width));
          applyServiceRender(currentServiceRender);
          lastRenderedSelectionKey = serviceRenderKey;
        }

        const serviceSummary = `Running ${currentServiceRender.runningCount}/${currentServiceRender.totalServices} services`;
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
        applyServiceRender(buildServiceContent(state, selectedService, Number(screen.width)));
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
