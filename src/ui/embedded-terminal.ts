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

export interface EmbeddedTerminalEnvironmentOptions {
  baseEnv?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface EmbeddedTerminalController {
  destroy(options?: { kill?: boolean; notify?: boolean; render?: boolean }): void;
  hide(options?: { notify?: boolean; render?: boolean }): void;
  isAlive(): boolean;
  isVisible(): boolean;
  resize(): void;
  show(): void;
}

export interface EmbeddedTerminalContentOptions {
  showCursor?: boolean;
}

export type EmbeddedTerminalMouseEncoding = "default" | "sgr";
export type EmbeddedTerminalWheelMode = "pass-through" | "scrollback";
export type EmbeddedTerminalWheelDirection = "up" | "down";

interface EmbeddedTerminalOptions {
  cwd: string;
  onDestroy?(): void;
  onEscapeInput?(): void;
  onHide?(): void;
  screen: Widgets.Screen;
  serviceName: string;
}

const CLOSE_REQUEST_DEDUPE_MS = 75;
const INITIAL_INPUT_READY_DELAY_MS = 250;
const NODE_PTY_HELPER_MODE = 0o755;
const PROMPT_SETTLE_DELAY_MS = 120;
const TERMINAL_RENDER_DEBOUNCE_MS = 16;
const TERMINAL_ENVIRONMENT_STRIP_PATTERN = /^(TERM_PROGRAM|TERMINAL|ITERM|LC_TERMINAL|WEZTERM|VTE|KITTY|WT_|GHOSTTY|BOLD|TABBY|VSCODE|TMUX|TMUX_)/;
const require = createRequire(import.meta.url);
const { Terminal: XtermTerminal } = xtermHeadless as typeof import("@xterm/headless");

interface EmbeddedTerminalProgram {
  disableMouse(): void;
  enableMouse(): void;
  mouseEnabled?: boolean;
}

interface EmbeddedTerminalMouseEvent extends blessed.Widgets.Events.IMouseEventArg {
  raw?: [number, number, number];
}

interface EmbeddedTerminalMousePosition {
  col: number;
  row: number;
}

interface HeadlessTerminalWithMouseEncoding extends HeadlessTerminal {
  _core?: {
    coreMouseService?: {
      activeEncoding?: string;
    };
  };
}

const DEFAULT_EMBEDDED_TERMINAL_WHEEL_SCROLL_LINES = 3;

export function calculateEmbeddedTerminalLayout(screenWidth: number, screenHeight: number): EmbeddedTerminalLayout {
  const boundedScreenWidth = Math.max(Math.floor(screenWidth), 1);
  const boundedScreenHeight = Math.max(Math.floor(screenHeight), 1);
  const width = boundedScreenWidth;
  const height = boundedScreenHeight;

  return {
    cols: Math.max(width - 2, 1),
    height,
    left: 0,
    rows: Math.max(height - 2, 1),
    top: 0,
    width,
  };
}

export function isStandaloneEscapeInput(input: Buffer | string): boolean {
  return Buffer.isBuffer(input) ? input.length === 1 && input[0] === 0x1b : input === "\x1b";
}

export function isEmbeddedTerminalMouseInput(input: Buffer | string): boolean {
  const normalizedInput = Buffer.isBuffer(input)
    ? input[0] > 127 && input[1] === undefined
      ? `\x1b${String.fromCharCode(input[0] - 128)}`
      : input.toString("utf8")
    : input;

  return (Buffer.isBuffer(input) && input[0] === 0x1b && input[1] === 0x5b && input[2] === 0x4d)
    || /^\x1b\[M([\x00\u0020-\uffff]{3})/.test(normalizedInput)
    || /^\x1b\[(\d+;\d+;\d+)M/.test(normalizedInput)
    || /^\x1b\[<(\d+;\d+;\d+)([mM])/.test(normalizedInput);
}

export function getEmbeddedTerminalHint(ptyAlive: boolean): string {
  return ptyAlive ? "Esc hide" : "exited - Esc return";
}

export function getEmbeddedTerminalMouseEncoding(
  terminal: HeadlessTerminal,
): EmbeddedTerminalMouseEncoding | null {
  if (terminal.modes.mouseTrackingMode === "none") {
    return null;
  }

  const activeEncoding = (terminal as HeadlessTerminalWithMouseEncoding)._core?.coreMouseService?.activeEncoding;
  return activeEncoding === "SGR" ? "sgr" : "default";
}

export function getEmbeddedTerminalWheelMode(terminal: HeadlessTerminal): EmbeddedTerminalWheelMode {
  return getEmbeddedTerminalMouseEncoding(terminal) ? "pass-through" : "scrollback";
}

export function translateEmbeddedTerminalMousePosition(
  eventX: number,
  eventY: number,
  layout: Pick<EmbeddedTerminalLayout, "cols" | "left" | "rows" | "top">,
): EmbeddedTerminalMousePosition {
  return {
    col: Math.min(Math.max(eventX - layout.left, 1), layout.cols),
    row: Math.min(Math.max(eventY - layout.top, 1), layout.rows),
  };
}

export function buildEmbeddedTerminalWheelInput(
  direction: EmbeddedTerminalWheelDirection,
  position: EmbeddedTerminalMousePosition,
  encoding: EmbeddedTerminalMouseEncoding,
): string {
  const buttonCode = direction === "up" ? 64 : 65;

  if (encoding === "sgr") {
    return `\x1b[<${buttonCode};${position.col};${position.row}M`;
  }

  return `\x1b[M${String.fromCharCode(buttonCode + 32)}${String.fromCharCode(position.col + 32)}${String.fromCharCode(position.row + 32)}`;
}

export function scrollEmbeddedTerminalViewport(
  terminal: HeadlessTerminal,
  direction: EmbeddedTerminalWheelDirection,
  lineCount = DEFAULT_EMBEDDED_TERMINAL_WHEEL_SCROLL_LINES,
): boolean {
  const initialViewportY = terminal.buffer.active.viewportY;
  terminal.scrollLines(direction === "up" ? -lineCount : lineCount);
  return terminal.buffer.active.viewportY !== initialViewportY;
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

export function buildEmbeddedTerminalEnvironment(
  {
    baseEnv = process.env,
    cwd,
  }: EmbeddedTerminalEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    COLORTERM: baseEnv.COLORTERM || "truecolor",
    PROMPT_EOL_MARK: "",
    TERM: "xterm-256color",
  };

  if (cwd) {
    env.PWD = cwd;
  }

  for (const key of Object.keys(env)) {
    if (TERMINAL_ENVIRONMENT_STRIP_PATTERN.test(key)) {
      delete env[key];
    }
  }

  return env;
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
  ptyAlive: boolean,
  width: number,
): string {
  return truncateLabel(` Terminal: ${serviceName} ${cwd} | ${getEmbeddedTerminalHint(ptyAlive)} `, Math.max(width - 2, 1));
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

  // Blessed on iTerm2 can emit Setulc/underline-color errors when underline
  // attributes are preserved from the PTY buffer. Keep the terminal content
  // stable by dropping underline while retaining the rest of the styling.

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
  const { cwd, onDestroy, onEscapeInput, onHide, screen, serviceName } = options;
  const program = screen.program as EmbeddedTerminalProgram;
  const terminalEnvironment = buildEmbeddedTerminalEnvironment({ baseEnv: process.env, cwd });
  const shell = resolveEmbeddedTerminalShell();
  let layout = calculateEmbeddedTerminalLayout(Number(screen.width), Number(screen.height));
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
  let terminalBinarySubscription: XtermDisposable | null = null;
  let terminalDataSubscription: XtermDisposable | null = null;
  let terminalWriteSubscription: XtermDisposable | null = null;
  let inputAttached = false;
  let pty: IPty | null = null;
  let ptyPath: string | null = null;
  let renderTimer: NodeJS.Timeout | null = null;
  const restoreMouseOnClose = Boolean(program.mouseEnabled);
  let enabledMouseForTerminal = false;
  let visible = true;
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
    label: buildTerminalLabel(serviceName, cwd, ptyAlive, layout.width),
    left: layout.left,
    mouse: true,
    scrollable: false,
    style: {
      border: { fg: UI_THEME.accent },
      fg: UI_THEME.text,
    },
    tags: true,
    top: layout.top,
    width: layout.width,
  });

  const requestTerminalRender = (immediate = false) => {
    if (closed || !visible) {
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
      if (!closed && visible) {
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

  const attachInputListener = () => {
    if (!inputListener || inputAttached) {
      return;
    }

    screen.program.input.on("data", inputListener);
    inputAttached = true;
  };

  const detachInputListener = () => {
    if (!inputListener || !inputAttached) {
      return;
    }

    screen.program.input.removeListener("data", inputListener);
    inputAttached = false;
  };

  const ensureMouseEnabled = () => {
    if (!program.mouseEnabled) {
      program.enableMouse();
      enabledMouseForTerminal = true;
    }
  };

  const restoreMouseState = () => {
    if (enabledMouseForTerminal && !restoreMouseOnClose) {
      program.disableMouse();
      enabledMouseForTerminal = false;
    }
  };

  const hide = ({
    notify = true,
    render = true,
  }: {
    notify?: boolean;
    render?: boolean;
  } = {}) => {
    if (closed || !visible) {
      return;
    }

    visible = false;
    detachInputListener();
    terminalBox.hide();
    restoreMouseState();

    if (notify) {
      onHide?.();
    }

    if (render) {
      screen.render();
    }
  };

  const show = () => {
    if (closed || visible) {
      return;
    }

    visible = true;
    ensureMouseEnabled();
    terminalBox.show();
    attachInputListener();
    updateLayout();
    terminalBox.focus();
    requestTerminalRender(true);
  };

  const destroy = ({
    kill = true,
    notify = false,
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
    terminalBinarySubscription?.dispose();
    terminalDataSubscription?.dispose();
    terminalWriteSubscription?.dispose();
    detachInputListener();
    inputListener = null;
    outputSubscription = null;
    exitSubscription = null;
    terminalBinarySubscription = null;
    terminalDataSubscription = null;
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
    restoreMouseState();
    visible = false;

    if (notify) {
      onDestroy?.();
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
    hide({ render: false });
  };

  const controller: EmbeddedTerminalController = {
    destroy,
    hide,
    isAlive: () => ptyAlive,
    isVisible: () => visible,
    resize: updateLayout,
    show,
  };

  const flushPendingStartupInput = () => {
    if (!ptyAlive || pendingStartupInput.length === 0) {
      pendingStartupInput = [];
      return;
    }

    const bufferedInput = pendingStartupInput.join("");
    pendingStartupInput = [];
    terminal.input(bufferedInput);
  };

  const markStartupInputReady = () => {
    ensureEmbeddedTerminalNoEcho(ptyPath);
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
    const label = buildTerminalLabel(serviceName, cwd, ptyAlive, layout.width);
    if (label === lastRenderedLabel) {
      return false;
    }

    terminalBox.setLabel(label);
    lastRenderedLabel = label;
    return true;
  }

  screen.append(terminalBox);
  ensureMouseEnabled();

  try {
    ensureNodePtySpawnHelperExecutable();
    pty = spawnPty(shell.command, shell.args, {
      cols: layout.cols,
      cwd,
      env: terminalEnvironment,
      name: terminalEnvironment.TERM || "xterm-256color",
      rows: layout.rows,
    });
    ptyPath = (pty as IPty & { _pty?: string })._pty ?? null;
    ensureEmbeddedTerminalNoEcho(ptyPath);
  } catch (error) {
    restoreMouseState();
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

  terminalDataSubscription = terminal.onData((data) => {
    if (!ptyAlive || closed) {
      return;
    }

    pty?.write(data);
  });

  terminalBinarySubscription = terminal.onBinary((data) => {
    if (!ptyAlive || closed) {
      return;
    }

    pty?.write(data);
  });

  const handleWheel = (direction: EmbeddedTerminalWheelDirection, event: EmbeddedTerminalMouseEvent) => {
    if (closed || !visible) {
      return;
    }

    const encoding = getEmbeddedTerminalMouseEncoding(terminal);
    if (encoding && ptyAlive) {
      const position = translateEmbeddedTerminalMousePosition(event.x, event.y, layout);
      pty?.write(buildEmbeddedTerminalWheelInput(direction, position, encoding));
      return;
    }

    if (scrollEmbeddedTerminalViewport(terminal, direction) && updateTerminalContent()) {
      requestTerminalRender();
    }
  };

  terminalBox.on("wheelup", (event) => {
    handleWheel("up", event as EmbeddedTerminalMouseEvent);
  });
  terminalBox.on("wheeldown", (event) => {
    handleWheel("down", event as EmbeddedTerminalMouseEvent);
  });

  inputListener = (input: Buffer | string) => {
    if (closed) {
      return;
    }

    if (isEmbeddedTerminalMouseInput(input)) {
      return;
    }

    if (isStandaloneEscapeInput(input)) {
      onEscapeInput?.();
      requestClose();
      return;
    }

    if (!ptyAlive) {
      return;
    }

    const inputText = Buffer.isBuffer(input) ? input.toString("utf8") : input;
    if (!startupInputReady) {
      pendingStartupInput.push(inputText);
      return;
    }

    terminal.input(inputText);
  };
  attachInputListener();

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
