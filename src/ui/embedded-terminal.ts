import { chmodSync, closeSync, existsSync, openSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import blessed, { type Widgets } from "blessed";
import xtermHeadless from "@xterm/headless";
import type { Terminal as HeadlessTerminal, IDisposable as XtermDisposable } from "@xterm/headless";
import { spawn as spawnPty, type IDisposable, type IPty } from "node-pty";
import { UI_THEME } from "./theme";

export interface EmbeddedTerminalLayout {
  cols: number;
  height: number;
  left: number;
  rows: number;
  top: number;
  width: number;
}

export interface EmbeddedTerminalShell {
  args: string[];
  command: string;
}

export type EmbeddedTerminalCloseState = "confirm" | "idle";
export type EmbeddedTerminalCloseEvent = "escape" | "input";

export interface EmbeddedTerminalCloseTransition {
  shouldClose: boolean;
  state: EmbeddedTerminalCloseState;
}

export interface EmbeddedTerminalController {
  destroy(options?: { kill?: boolean; notify?: boolean; render?: boolean }): void;
  requestClose(): void;
  resize(): void;
}

export interface EmbeddedTerminalContentOptions {
  showCursor?: boolean;
}

interface EmbeddedTerminalOptions {
  cwd: string;
  onClose(): void;
  onEscapeInput?(): void;
  screen: Widgets.Screen;
  serviceName: string;
}

const CLOSE_REQUEST_DEDUPE_MS = 75;
const INITIAL_INPUT_READY_DELAY_MS = 250;
const NODE_PTY_HELPER_MODE = 0o755;
const PROMPT_SETTLE_DELAY_MS = 120;
const TERMINAL_RENDER_DEBOUNCE_MS = 16;
const require = createRequire(import.meta.url);
const { Terminal: XtermTerminal } = xtermHeadless as typeof import("@xterm/headless");

interface EmbeddedTerminalProgram {
  disableMouse(): void;
  enableMouse(): void;
  mouseEnabled?: boolean;
}

export function calculateEmbeddedTerminalLayout(screenWidth: number, screenHeight: number): EmbeddedTerminalLayout {
  const boundedScreenWidth = Math.max(Math.floor(screenWidth), 1);
  const boundedScreenHeight = Math.max(Math.floor(screenHeight), 1);
  const width = Math.max(1, Math.min(boundedScreenWidth, Math.floor(boundedScreenWidth * 0.9)));
  const height = Math.max(1, Math.min(boundedScreenHeight, Math.floor(boundedScreenHeight * 0.9)));

  return {
    cols: Math.max(width - 2, 1),
    height,
    left: Math.max(Math.floor((boundedScreenWidth - width) / 2), 0),
    rows: Math.max(height - 2, 1),
    top: Math.max(Math.floor((boundedScreenHeight - height) / 2), 0),
    width,
  };
}

export function getNextEmbeddedTerminalCloseTransition(
  state: EmbeddedTerminalCloseState,
  event: EmbeddedTerminalCloseEvent,
  ptyAlive: boolean,
): EmbeddedTerminalCloseTransition {
  if (event === "input") {
    return { shouldClose: false, state: "idle" };
  }

  if (!ptyAlive || state === "confirm") {
    return { shouldClose: true, state };
  }

  return { shouldClose: false, state: "confirm" };
}

export function isStandaloneEscapeInput(input: Buffer | string): boolean {
  return Buffer.isBuffer(input) ? input.length === 1 && input[0] === 0x1b : input === "\x1b";
}

export function resolveEmbeddedTerminalShell(
  {
    env = process.env,
    platform = process.platform,
  }: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): EmbeddedTerminalShell {
  if (platform === "win32") {
    return { args: [], command: env.COMSPEC || "cmd.exe" };
  }

  return { args: ["-i"], command: env.SHELL || "/bin/sh" };
}

export function getNodePtySpawnHelperPath({
  arch = process.arch,
  platform = process.platform,
  resolvedNodePtyEntry = require.resolve("node-pty"),
}: {
  arch?: NodeJS.Architecture;
  platform?: NodeJS.Platform;
  resolvedNodePtyEntry?: string;
} = {}): string | null {
  if (platform !== "darwin") {
    return null;
  }

  return path.resolve(
    path.dirname(resolvedNodePtyEntry),
    "..",
    "prebuilds",
    `${platform}-${arch}`,
    "spawn-helper",
  );
}

export function ensureNodePtySpawnHelperExecutable(helperPath = getNodePtySpawnHelperPath()): void {
  if (!helperPath || !existsSync(helperPath)) {
    return;
  }

  const currentMode = statSync(helperPath).mode;
  if ((currentMode & 0o111) !== 0) {
    return;
  }

  chmodSync(helperPath, currentMode | NODE_PTY_HELPER_MODE);
}

export function ensureEmbeddedTerminalNoEcho(ptyPath: string | null | undefined): void {
  if (!ptyPath || process.platform === "win32") {
    return;
  }

  const ttyFd = openSync(ptyPath, "r+");
  try {
    spawnSync("stty", ["-echo"], {
      stdio: [ttyFd, "ignore", "ignore"],
    });
  } finally {
    closeSync(ttyFd);
  }
}

function truncateLabel(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) {
    return value;
  }

  if (maxWidth <= 3) {
    return value.slice(0, maxWidth);
  }

  return `${value.slice(0, maxWidth - 3)}...`;
}

function buildTerminalLabel(
  serviceName: string,
  cwd: string,
  closeState: EmbeddedTerminalCloseState,
  ptyAlive: boolean,
  width: number,
): string {
  const hint = !ptyAlive
    ? "exited - Esc close"
    : closeState === "confirm"
      ? "Esc again to kill"
      : "Esc close";

  return truncateLabel(` Terminal: ${serviceName} ${cwd} | ${hint} `, Math.max(width - 2, 1));
}

function escapeBlessedTagText(value: string): string {
  return value
    .replaceAll("{", "{open}")
    .replaceAll("}", "{close}");
}

function formatBlessedColorTag(color: number, isRgb: boolean, suffix: "bg" | "fg"): string {
  if (isRgb) {
    return `#${color.toString(16).padStart(6, "0")}-${suffix}`;
  }

  return `${color}-${suffix}`;
}

function getCellStyleTag(cell: ReturnType<HeadlessTerminal["buffer"]["active"]["getNullCell"]>): string {
  const styleParts: string[] = [];

  if (cell.isBold()) {
    styleParts.push("bold");
  }

  if (cell.isUnderline()) {
    styleParts.push("underline");
  }

  if (cell.isBlink()) {
    styleParts.push("blink");
  }

  if (cell.isInvisible()) {
    styleParts.push("invisible");
  }

  if (cell.isInverse()) {
    styleParts.push("inverse");
  }

  if (!cell.isFgDefault()) {
    styleParts.push(formatBlessedColorTag(cell.getFgColor(), cell.isFgRGB(), "fg"));
  }

  if (!cell.isBgDefault()) {
    styleParts.push(formatBlessedColorTag(cell.getBgColor(), cell.isBgRGB(), "bg"));
  }

  return styleParts.join(",");
}

export function buildEmbeddedTerminalContent(
  terminal: HeadlessTerminal,
  { showCursor = true }: EmbeddedTerminalContentOptions = {},
): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  const emptyCell = buffer.getNullCell();
  const scratchCell = buffer.getNullCell();

  for (let row = 0; row < terminal.rows; row++) {
    const bufferLine = buffer.getLine(buffer.viewportY + row);
    const cursorColumn = Math.min(Math.max(buffer.cursorX, 0), Math.max(terminal.cols - 1, 0));
    let activeStyleTag = "";
    let line = "";

    for (let column = 0; column < terminal.cols; column++) {
      const cell = bufferLine?.getCell(column, scratchCell) ?? emptyCell;
      const width = Math.max(cell.getWidth(), 1);

      if (width === 0) {
        continue;
      }

      const isCursorCell = showCursor && row === buffer.cursorY && column === cursorColumn;
      const styleTag = [getCellStyleTag(cell), isCursorCell ? "inverse" : ""]
        .filter((value) => value.length > 0)
        .join(",");

      if (styleTag !== activeStyleTag) {
        if (activeStyleTag) {
          line += "{/}";
        }

        if (styleTag) {
          line += `{${styleTag}}`;
        }

        activeStyleTag = styleTag;
      }

      line += escapeBlessedTagText(cell.getChars() || " ");

      if (width > 1) {
        column += width - 1;
      }
    }

    if (activeStyleTag) {
      line += "{/}";
    }

    lines.push(line);
  }

  return lines.join("\n");
}

export function openEmbeddedTerminal(options: EmbeddedTerminalOptions): EmbeddedTerminalController {
  const { cwd, onClose, onEscapeInput, screen, serviceName } = options;
  const program = screen.program as EmbeddedTerminalProgram;
  const shell = resolveEmbeddedTerminalShell();
  let layout = calculateEmbeddedTerminalLayout(Number(screen.width), Number(screen.height));
  let closeState: EmbeddedTerminalCloseState = "idle";
  let closed = false;
  let lastCloseRequestAt = 0;
  let lastRenderedContent = "";
  let lastRenderedLabel = "";
  let pendingStartupInput: string[] = [];
  let ptyAlive = true;
  let readyTimer: NodeJS.Timeout | null = null;
  let startupInputReady = false;
  let outputSubscription: IDisposable | null = null;
  let exitSubscription: IDisposable | null = null;
  let inputListener: ((input: Buffer | string) => void) | null = null;
  let terminalWriteSubscription: XtermDisposable | null = null;
  let pty: IPty | null = null;
  let renderTimer: NodeJS.Timeout | null = null;
  const restoreMouseOnClose = Boolean(program.mouseEnabled);
  const terminal = new XtermTerminal({
    allowProposedApi: true,
    cols: layout.cols,
    cursorStyle: "block",
    logLevel: "off",
    rows: layout.rows,
    scrollback: 2_000,
  });

  const terminalBox = blessed.box({
    border: "line",
    focusable: true,
    height: layout.height,
    label: buildTerminalLabel(serviceName, cwd, closeState, ptyAlive, layout.width),
    left: layout.left,
    mouse: false,
    scrollable: false,
    style: {
      bg: "black",
      border: { fg: "blue" },
      fg: UI_THEME.text,
    },
    tags: true,
    top: layout.top,
    width: layout.width,
  });

  const requestTerminalRender = (immediate = false) => {
    if (closed) {
      return;
    }

    if (immediate) {
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      screen.render();
      return;
    }

    if (renderTimer) {
      return;
    }

    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (!closed) {
        screen.render();
      }
    }, TERMINAL_RENDER_DEBOUNCE_MS);
  };

  const updateTerminalContent = () => {
    const content = buildEmbeddedTerminalContent(terminal);
    if (content === lastRenderedContent) {
      return false;
    }

    terminalBox.setContent(content);
    lastRenderedContent = content;
    return true;
  };

  const updateLayout = () => {
    layout = calculateEmbeddedTerminalLayout(Number(screen.width), Number(screen.height));
    terminalBox.top = layout.top;
    terminalBox.left = layout.left;
    terminalBox.width = layout.width;
    terminalBox.height = layout.height;
    terminal.resize(layout.cols, layout.rows);
    updateLabel();
    updateTerminalContent();

    if (ptyAlive) {
      try {
        pty?.resize(layout.cols, layout.rows);
      } catch {
        // The PTY can exit between the alive check and resize.
      }
    }

    requestTerminalRender(true);
  };

  const destroy = ({
    kill = true,
    notify = true,
    render = true,
  }: {
    kill?: boolean;
    notify?: boolean;
    render?: boolean;
  } = {}) => {
    if (closed) {
      return;
    }

    closed = true;
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    outputSubscription?.dispose();
    exitSubscription?.dispose();
    terminalWriteSubscription?.dispose();
    if (inputListener) {
      screen.program.input.removeListener("data", inputListener);
      inputListener = null;
    }
    outputSubscription = null;
    exitSubscription = null;
    terminalWriteSubscription = null;

    if (kill && ptyAlive) {
      try {
        pty?.kill();
      } catch {
        // A PTY that has just exited can throw on kill.
      }
    }

    terminal.dispose();
    terminalBox.destroy();
    screen.clearRegion(layout.left, layout.left + layout.width, layout.top, layout.top + layout.height);
    if (restoreMouseOnClose) {
      program.enableMouse();
    }

    if (notify) {
      onClose();
    }

    if (render) {
      screen.render();
    }
  };

  const requestClose = () => {
    const now = Date.now();
    if (now - lastCloseRequestAt < CLOSE_REQUEST_DEDUPE_MS) {
      return;
    }
    lastCloseRequestAt = now;

    const transition = getNextEmbeddedTerminalCloseTransition(closeState, "escape", ptyAlive);
    closeState = transition.state;

    if (transition.shouldClose) {
      destroy();
      return;
    }

    updateLabel();
    requestTerminalRender(true);
  };

  const controller: EmbeddedTerminalController = {
    destroy,
    requestClose,
    resize: updateLayout,
  };

  const flushPendingStartupInput = () => {
    if (!ptyAlive || pendingStartupInput.length === 0) {
      pendingStartupInput = [];
      return;
    }

    const bufferedInput = pendingStartupInput.join("");
    pendingStartupInput = [];
    pty?.write(bufferedInput);
  };

  const markStartupInputReady = () => {
    startupInputReady = true;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    flushPendingStartupInput();
  };

  const scheduleStartupInputReady = (delayMs: number) => {
    if (startupInputReady) {
      return;
    }

    if (readyTimer) {
      clearTimeout(readyTimer);
    }

    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (!closed) {
        markStartupInputReady();
      }
    }, delayMs);
  };

  function updateLabel() {
    const label = buildTerminalLabel(serviceName, cwd, closeState, ptyAlive, layout.width);
    if (label === lastRenderedLabel) {
      return false;
    }

    terminalBox.setLabel(label);
    lastRenderedLabel = label;
    return true;
  }

  screen.append(terminalBox);
  if (restoreMouseOnClose) {
    program.disableMouse();
  }

  try {
    ensureNodePtySpawnHelperExecutable();
    pty = spawnPty(shell.command, shell.args, {
      cols: layout.cols,
      cwd,
      env: {
        ...process.env,
        COLORTERM: process.env.COLORTERM || "truecolor",
        TERM: process.env.TERM || "xterm-256color",
      },
      name: process.env.TERM || "xterm-256color",
      rows: layout.rows,
    });
    ensureEmbeddedTerminalNoEcho((pty as IPty & { _pty?: string })._pty);
  } catch (error) {
    if (restoreMouseOnClose) {
      program.enableMouse();
    }
    terminal.dispose();
    terminalBox.destroy();
    throw error;
  }

  scheduleStartupInputReady(INITIAL_INPUT_READY_DELAY_MS);

  terminalWriteSubscription = terminal.onWriteParsed(() => {
    if (closed) {
      return;
    }

    if (updateTerminalContent()) {
      requestTerminalRender();
    }
  });

  inputListener = (input: Buffer | string) => {
    if (closed) {
      return;
    }

    if (isStandaloneEscapeInput(input)) {
      onEscapeInput?.();
      controller.requestClose();
      return;
    }

    const previousCloseState = closeState;
    const transition = getNextEmbeddedTerminalCloseTransition(closeState, "input", ptyAlive);
    closeState = transition.state;
    if (closeState !== previousCloseState) {
      updateLabel();
      requestTerminalRender();
    }

    if (!ptyAlive) {
      return;
    }

    const inputText = Buffer.isBuffer(input) ? input.toString("utf8") : input;
    if (!startupInputReady) {
      pendingStartupInput.push(inputText);
      return;
    }

    pty?.write(inputText);
  };
  screen.program.input.on("data", inputListener);

  outputSubscription = pty.onData((data) => {
    if (closed) {
      return;
    }

    scheduleStartupInputReady(PROMPT_SETTLE_DELAY_MS);
    terminal.write(data);
  });

  exitSubscription = pty.onExit((event) => {
    if (closed) {
      return;
    }

    ptyAlive = false;
    closeState = "idle";
    startupInputReady = true;
    pendingStartupInput = [];
    terminal.write(`\r\n[terminal exited with code ${event.exitCode}]\r\n`);
    updateLabel();
    requestTerminalRender(true);
  });

  updateTerminalContent();
  updateLabel();
  terminalBox.focus();
  requestTerminalRender(true);
  return controller;
}
