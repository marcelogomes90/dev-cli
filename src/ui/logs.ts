import { open as openFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";

export const LOG_TAIL_LINES = 320;

const LOG_TAIL_READ_BYTES = 192 * 1024;
const MAX_INCREMENTAL_READ_BYTES = 128 * 1024;
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
  process.stdout.write(content);
  process.exit(0);
}

let cleanedUp = false;

function terminalRows() {
  return Math.max(1, stdout.rows || 24);
}

function clearScreenAndScrollback() {
  stdout.write("\n".repeat(terminalRows()));
  stdout.write("\x1b[3J\x1b[2J\x1b[H");
}

function cleanup() {
  if (cleanedUp) {
    return;
  }

  cleanedUp = true;
  clearScreenAndScrollback();
  stdout.write("\x1b[?25h\x1b[0m");
  stdin.setRawMode(false);
}

function finish() {
  cleanup();
  process.exit(0);
}

process.on("exit", cleanup);

stdout.write("\x1b[?25l\x1b[0m");
clearScreenAndScrollback();
stdout.write(content);
if (content.length > 0 && !content.endsWith("\n")) {
  stdout.write("\n");
}
stdout.write("\x1b[2m--- press v or q to return ---\x1b[0m");

stdin.setRawMode(true);
stdin.resume();
stdin.on("data", (chunk) => {
  const input = chunk.toString("utf8");
  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);
    if (rest[0] === "\x1b") {
      i += 1; continue;
    }
    if (input[i] === "v" || input[i] === "q") finish();
    if (input[i] === "\x03") finish();
    i += 1;
  }
});
`;

export interface LogCache {
  content: string;
  mtimeMs: number;
  pathname: string;
  size: number;
}

export interface LogViewerCommand {
  args: string[];
  command: string;
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

export interface LogViewerScreen {
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

function takeTailLines(value: string, maxLines: number): string {
  const lines = value.split("\n");
  return lines.slice(-maxLines).join("\n");
}

export async function readLogTail(
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
