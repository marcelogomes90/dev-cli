import { spawn } from "node:child_process";
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
import {
  openActionModal,
  type ActionModalController,
} from "./action-modal";
import { buildHeaderContent, FOOTER_HEIGHT, getSupervisorPaneLayout, HEADER_HEIGHT } from "./layout";
import {
  openEmbeddedTerminal,
  type EmbeddedTerminalController,
} from "./embedded-terminal";
import {
  buildLogViewerCommand,
  launchExternalLogViewer,
  LOG_TAIL_LINES,
  readLogTail,
  type LogCache,
  type LogViewerScreen,
} from "./logs";
import {
  computeCpuPercent,
  formatResourceMetrics,
  getCpuSnapshot,
  readRamUsage,
  type CpuSnapshot,
  type ResourceMetrics,
} from "./metrics";
import {
  buildServiceContent,
  buildShortcutItems,
  buildShortcutLine,
  type ServiceRenderResult,
  type ShortcutItem,
} from "./services";
import { muted, toneTag, truncate, UI_THEME, type MessageTone } from "./theme";
export { detectTerminalThemeVariant, isLightTerminalBackground, resolveUiTheme, UI_THEME, type TerminalThemeVariant, type UiTheme } from "./theme";

export {
  buildEmbeddedTerminalWheelInput,
  buildEmbeddedTerminalEnvironment,
  buildEmbeddedTerminalContent,
  calculateEmbeddedTerminalLayout,
  ensureNodePtySpawnHelperExecutable,
  getEmbeddedTerminalMouseEncoding,
  getEmbeddedTerminalHint,
  getNodePtySpawnHelperPath,
  getEmbeddedTerminalWheelMode,
  isEmbeddedTerminalMouseInput,
  isStandaloneEscapeInput,
  resolveEmbeddedTerminalShell,
  scrollEmbeddedTerminalViewport,
  translateEmbeddedTerminalMousePosition,
  type EmbeddedTerminalContentOptions,
  type EmbeddedTerminalLayout,
  type EmbeddedTerminalMouseEncoding,
  type EmbeddedTerminalShell,
  type EmbeddedTerminalWheelDirection,
  type EmbeddedTerminalWheelMode,
} from "./embedded-terminal";
export { buildHeaderContent, getSupervisorPaneLayout, type SupervisorPaneLayout } from "./layout";
export { buildLogViewerCommand, launchExternalLogViewer, type LogViewerCommand } from "./logs";
export { computeCpuPercent, formatResourceMetrics, parseDarwinMemoryUsage, type CpuSnapshot, type ResourceMetrics } from "./metrics";
export { buildServiceContent, buildShortcutItems, buildShortcutLine, type ServiceRenderResult, type ShortcutItem } from "./services";
export { calculateActionModalLayout, formatActionModalInputValue, type ActionModalLayout } from "./action-modal";

type UiMode = "modal" | "navigate" | "terminal";

interface FooterMessage {
  text: string;
  tone: MessageTone;
}

const METRICS_REFRESH_MS = 1_000;
const SCREEN_POLL_MS = 500;
const SCREEN_RENDER_DEBOUNCE_MS = 16;
const BACKGROUND_LOG_REFRESH_MS = 2_000;

export interface TuiProgramOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  terminal?: string;
}

interface StableMouseProgram {
  enableMouse(): void;
  mouseEnabled?: boolean;
  setMouse?(options: Record<string, boolean>, enable?: boolean): void;
  _devCliStableMouseMode?: boolean;
}

const BLESSED_PLAB_NORM_ERROR_PATTERN = /^Error on .+\.plab_norm:$/;

export function applyStableTuiMouseMode(program: StableMouseProgram): void {
  program.setMouse?.({ sgrMouse: true }, true);
}

export function configureStableTuiMouseMode(program: StableMouseProgram): void {
  if (program._devCliStableMouseMode) {
    return;
  }

  const enableMouse = program.enableMouse.bind(program);
  program.enableMouse = () => {
    enableMouse();
    applyStableTuiMouseMode(program);
  };
  program._devCliStableMouseMode = true;

  if (program.mouseEnabled) {
    applyStableTuiMouseMode(program);
  }
}

export function createTuiProgram(options = buildTuiProgramOptions()) {
  const originalConsoleError = console.error;
  const consoleErrorCalls: unknown[][] = [];
  let hasBlessedPlabNormError = false;

  try {
    console.error = (...args: unknown[]) => {
      const firstArg = typeof args[0] === "string" ? args[0] : "";
      const rendered = args.length > 1 ? firstArg.replaceAll("%s", String(args[1])) : firstArg;
      if (BLESSED_PLAB_NORM_ERROR_PATTERN.test(rendered)) {
        hasBlessedPlabNormError = true;
      }
      consoleErrorCalls.push(args);
    };
    return blessed.program(options);
  } finally {
    console.error = originalConsoleError;
    if (!hasBlessedPlabNormError) {
      for (const args of consoleErrorCalls) {
        originalConsoleError(...args);
      }
    }
  }
}

export function buildTuiProgramOptions(
  {
    input = process.stdin,
    output = process.stdout,
    terminal = process.env.TERM || "xterm-256color",
  }: TuiProgramOptions = {},
) {
  return {
    buffer: true,
    extended: false,
    input: input as unknown as blessed.Widgets.IScreenOptions["input"],
    output: output as unknown as blessed.Widgets.IScreenOptions["output"],
    terminal,
    tput: true,
    zero: true,
  } as unknown as Parameters<typeof blessed.program>[0];
}

export function countLiveEmbeddedTerminalSessions(
  sessions: ReadonlyMap<string, Pick<EmbeddedTerminalController, "isAlive">>,
): number {
  let liveCount = 0;

  for (const session of sessions.values()) {
    if (session.isAlive()) {
      liveCount += 1;
    }
  }

  return liveCount;
}

export function buildEmbeddedTerminalExitMessage(liveSessionCount: number): string {
  if (liveSessionCount === 1) {
    return "Exit the UI and kill 1 embedded terminal session?";
  }

  return `Exit the UI and kill ${liveSessionCount} embedded terminal sessions?`;
}

export function getActiveEmbeddedTerminalSessionServices(
  sessions: ReadonlyMap<string, Pick<EmbeddedTerminalController, "isAlive">>,
): Set<string> {
  const activeServices = new Set<string>();

  for (const [serviceName, session] of sessions.entries()) {
    if (session.isAlive()) {
      activeServices.add(serviceName);
    }
  }

  return activeServices;
}

export function buildFooterShortcutLine(
  items: readonly ShortcutItem[],
  availableWidth: number,
): string {
  const normalizedWidth = Math.max(availableWidth, 1);
  const helpItem = items.find((item) => item.label === "[?] Help") ?? null;
  const otherItems = items.filter((item) => item.label !== "[?] Help");
  const helpWidth = helpItem ? helpItem.label.length : 0;
  const reservedSeparatorWidth = helpItem && otherItems.length > 0 ? 3 : 0;
  let remainingWidth = normalizedWidth - helpWidth - reservedSeparatorWidth;
  const selectedItems: string[] = [];

  for (const item of otherItems.sort((left, right) => right.priority - left.priority)) {
    const separatorWidth = selectedItems.length > 0 ? 3 : 0;
    const neededWidth = separatorWidth + item.label.length;
    if (selectedItems.length === 0 && item.label.length > remainingWidth) {
      continue;
    }
    if (neededWidth > remainingWidth) {
      continue;
    }

    selectedItems.push(item.label);
    remainingWidth -= neededWidth;
  }

  if (helpItem) {
    selectedItems.push(helpItem.label);
  }

  return selectedItems.join(" | ");
}

function buildShortcutHelpContent(items: readonly ShortcutItem[]): string {
  return items.map((item) => item.label).join("\n");
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
      text: response.results.length === 1
        ? `${response.results[0].service}: ${response.results[0].message}`
        : response.message ?? `${response.results.length}/${response.results.length} actions completed.`,
      tone: "success",
    };
  }

  return { text: response.message ?? fallback, tone: "success" };
}

function buildServiceRenderKey(
  state: SupervisorState,
  selectedService: string | null,
  screenWidth: number,
  screenHeight: number,
  logCacheVersion: number,
  activeTerminalSessions: ReadonlySet<string>,
): string {
  const serviceParts: string[] = [];
  for (const [groupName, serviceNames] of Object.entries(state.groups)) {
    serviceParts.push(`group=${groupName}`);
    for (const serviceName of serviceNames) {
      const service = state.services[serviceName];
      if (!service) {
        serviceParts.push(`${serviceName}:missing`);
        continue;
      }

      serviceParts.push([
        service.service,
        service.status,
        service.isGit ? service.branch : "-",
        service.pid ?? "-",
        service.lastStartedAt ?? "-",
        service.lastStoppedAt ?? "-",
        service.exitCode ?? "-",
        service.memoryBytes ?? "-",
        service.cpuPercent ?? "-",
      ].join(","));
    }
  }

  return [
    selectedService ?? "-",
    screenWidth,
    screenHeight,
    logCacheVersion,
    Math.floor(Date.now() / 1000),
    [...activeTerminalSessions].sort().join(","),
    ...serviceParts,
  ].join("|");
}

export async function openSupervisorTui(config: ProjectConfig): Promise<void> {
  await new Promise<void>((resolve) => {
    const initialPaneLayout = getSupervisorPaneLayout(process.stdout.columns ?? 120, process.stdout.rows ?? 32);
    const program = createTuiProgram();
    configureStableTuiMouseMode(program);
    const screen = blessed.screen({
      fullUnicode: true,
      program,
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
      text: "UI connected. Use s or Enter to start services individually.",
      tone: "info",
    };
    let selectedService: string | null = null;
    let serviceNames: string[] = [];
    let logPinnedToBottom = true;
    let rendering = false;
    let renderPending = false;
    let renderTimer: NodeJS.Timeout | null = null;
    let screenClosed = false;
    let actionModal: ActionModalController | null = null;
    let visibleEmbeddedTerminalService: string | null = null;
    let lastModalInteractionAt = 0;
    let lastTerminalEscapeAt = 0;
    let lastMetricsRefreshAt = 0;
    let lastBackgroundLogRefreshAt = Date.now();
    let lastFooterContent = "";
    let lastHeaderContent = "";
    let lastLogContent = "";
    let lastLogLabel = "";
    let lastPaneLayoutKey = "";
    let lastServicesContent = "";
    let lastServicesFrameLabel = "";
    let lastServicesHeaderContent = "";
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
    const pendingRefreshes = new Set<string>();
    const pendingServiceActions = new Map<string, string>();
    const embeddedTerminalSessions = new Map<string, EmbeddedTerminalController>();

    const setFooterMessage = (tone: MessageTone, text: string) => {
      footerMessage = { text, tone };
    };

    const requestScreenRender = (immediate = false) => {
      if (screenClosed) {
        return;
      }

      if (mode === "terminal") {
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
        if (!screenClosed) {
          screen.render();
        }
      }, SCREEN_RENDER_DEBOUNCE_MS);
    };

    const getSelectedService = (): ManagedServiceState | null => {
      if (!state || !selectedService) {
        return null;
      }

      return state.services[selectedService] ?? null;
    };

    const getSelectedBusyAction = (): string | null => {
      if (!selectedService) {
        return null;
      }

      return pendingServiceActions.get(selectedService) ?? null;
    };

    const getVisibleEmbeddedTerminal = (): EmbeddedTerminalController | null => {
      if (!visibleEmbeddedTerminalService) {
        return null;
      }

      return embeddedTerminalSessions.get(visibleEmbeddedTerminalService) ?? null;
    };

    const isEmbeddedTerminalVisible = (): boolean => getVisibleEmbeddedTerminal()?.isVisible() ?? false;

    const getLiveEmbeddedTerminalCount = (): number => countLiveEmbeddedTerminalSessions(embeddedTerminalSessions);
    const getActiveEmbeddedTerminalServices = (): Set<string> => getActiveEmbeddedTerminalSessionServices(embeddedTerminalSessions);
    const hasActiveEmbeddedTerminalSession = (serviceName: string | null): boolean => {
      if (!serviceName) {
        return false;
      }

      return embeddedTerminalSessions.get(serviceName)?.isAlive() ?? false;
    };

    const hideVisibleEmbeddedTerminal = ({
      notify = true,
      render = false,
    }: {
      notify?: boolean;
      render?: boolean;
    } = {}) => {
      const visibleTerminal = getVisibleEmbeddedTerminal();
      if (!visibleTerminal) {
        visibleEmbeddedTerminalService = null;
        return;
      }

      visibleEmbeddedTerminalService = null;
      visibleTerminal.hide({ notify, render });
    };

    const destroyEmbeddedTerminalSession = (
      serviceName: string,
      {
        kill = true,
        notify = false,
        render = false,
      }: {
        kill?: boolean;
        notify?: boolean;
        render?: boolean;
      } = {},
    ) => {
      const session = embeddedTerminalSessions.get(serviceName);
      if (!session) {
        if (visibleEmbeddedTerminalService === serviceName) {
          visibleEmbeddedTerminalService = null;
        }
        return;
      }

      if (visibleEmbeddedTerminalService === serviceName) {
        visibleEmbeddedTerminalService = null;
      }
      embeddedTerminalSessions.delete(serviceName);
      session.destroy({ kill, notify, render });
    };

    const destroyAllEmbeddedTerminalSessions = ({
      kill = true,
      notify = false,
      render = false,
    }: {
      kill?: boolean;
      notify?: boolean;
      render?: boolean;
    } = {}) => {
      for (const serviceName of [...embeddedTerminalSessions.keys()]) {
        destroyEmbeddedTerminalSession(serviceName, { kill, notify, render });
      }
    };

    const guardSelectedServiceIdle = (actionLabel: string): boolean => {
      const selected = getSelectedService();
      if (!selected) {
        setFooterMessage("warning", "No service selected.");
        void render();
        return false;
      }

      const busyAction = pendingServiceActions.get(selected.service);
      if (busyAction) {
        setFooterMessage("warning", `${selected.service} is busy with ${busyAction}. Wait until it finishes before ${actionLabel}.`);
        renderFooter();
        requestScreenRender(true);
        return false;
      }

      return true;
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

    const renderFooter = (): boolean => {
      const selected = getSelectedService();
      const message = footerMessage.text;
      const busyAction = getSelectedBusyAction();
      const tone = busyAction ? "warning" : footerMessage.tone;
      const footerInset = Number(screen.width) > 48 ? 2 : 1;
      const inset = " ".repeat(footerInset);
      const availableWidth = Math.max(Number(screen.width) - 2 - footerInset * 2, 10);
      const shortcuts =
        mode === "terminal"
          ? "[Esc] Hide terminal"
          : busyAction
            ? buildFooterShortcutLine([
              { label: "[↑/↓] Move", priority: 100 },
              { label: "[v] View logs", priority: 65 },
              { label: "[q] Quit", priority: 64 },
              { label: "[?] Help", priority: 63 },
            ], availableWidth)
            : buildFooterShortcutLine(
              buildShortcutItems(
                selected,
                selectedHasLogs(),
                hasActiveEmbeddedTerminalSession(selected?.service ?? null),
              ),
              availableWidth,
            );
      const content = `${inset}{${toneTag(tone)}}${truncate(message, availableWidth).trimEnd()}{/${toneTag(tone)}}\n${inset}${muted(shortcuts.trimEnd())}`;
      if (content === lastFooterContent) {
        return false;
      }

      footer.setContent(content);
      lastFooterContent = content;
      return true;
    };

    const applyPaneLayout = (): boolean => {
      const paneLayout = getSupervisorPaneLayout(Number(screen.width), Number(screen.height));
      const paneLayoutKey = [
        paneLayout.logHeight,
        paneLayout.logTop,
        paneLayout.logWidth,
        paneLayout.servicesHeight,
        paneLayout.servicesTop,
        paneLayout.servicesWidth,
      ].join(":");
      if (paneLayoutKey === lastPaneLayoutKey) {
        return false;
      }

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
      lastPaneLayoutKey = paneLayoutKey;
      return true;
    };

    const renderHeader = (serviceSummary: string): boolean => {
      const metricsText = formatResourceMetrics(resourceMetrics);
      const content = buildHeaderContent(config.project, serviceSummary, metricsText, Number(screen.width));
      if (content === lastHeaderContent) {
        return false;
      }

      header.setContent(content);
      lastHeaderContent = content;
      return true;
    };

    const centerInLogBox = (text: string): string => {
      const h = Math.max(1, (Number(logBox.height) || 10) - 2);
      const w = Math.max(1, (Number(logBox.width) || 20) - 2);
      const vertPad = Math.max(0, Math.floor((h - 1) / 2));
      const horizPad = Math.max(0, Math.floor((w - text.length) / 2));
      return "\n".repeat(vertPad) + " ".repeat(horizPad) + muted(text);
    };

    const applyLogContent = (serviceName: string | null): boolean => {
      if (!serviceName || !state?.services[serviceName]) {
        const label = " Logs ";
        const content = centerInLogBox("No service selected.");
        const changed = label !== lastLogLabel || content !== lastLogContent;
        if (changed) {
          logBox.setLabel(label);
          logBox.setContent(content);
          lastLogLabel = label;
          lastLogContent = content;
        }
        return changed;
      }

      const service = state.services[serviceName];
      const cached = logCaches.get(serviceName);
      const isActive =
        service.status === "running" ||
        service.status === "restarting" ||
        service.status === "starting" ||
        service.status === "installing";
      const rawContent = !cached && isActive
        ? "Loading logs..."
        : getDisplayLogContent(service, cached);
      const content = rawContent.replace(/^\n+/, "");
      const follow = logPinnedToBottom ? " follow" : " paused";
      const label = ` Logs: ${service.service} / ${service.status}${follow} `;
      const renderedContent =
        content === "No logs yet." || content === "Loading logs..."
          ? centerInLogBox(content)
          : content;
      const changed = label !== lastLogLabel || renderedContent !== lastLogContent;

      if (changed) {
        logBox.setLabel(label);
        logBox.setContent(renderedContent);
        lastLogLabel = label;
        lastLogContent = renderedContent;
      }

      const contentLines = content.split("\n").length;
      const boxVisibleLines = Math.max(1, (Number(logBox.height) || 10) - 2);

      if (contentLines <= boxVisibleLines) {
        logBox.setScrollPerc(0);
      } else if (logPinnedToBottom) {
        logBox.setScrollPerc(100);
      }

      return changed;
    };

    const refreshLogCache = (serviceName: string) => {
      if (!state?.services[serviceName]) {
        return;
      }

      if (logRefreshes.has(serviceName)) {
        pendingRefreshes.add(serviceName);
        return;
      }

      pendingRefreshes.delete(serviceName);
      const service = state.services[serviceName];
      const previousCache = logCaches.get(serviceName) ?? null;
      const refresh = readLogTail(service.logPath, previousCache, LOG_TAIL_LINES)
        .then((cache) => {
          const cacheChanged = cache !== previousCache;
          let dirty = false;
          logCaches.set(serviceName, cache);
          if (cacheChanged) {
            logCacheVersion += 1;
          }
          if (cacheChanged && state) {
            dirty = applyServiceRender(
              buildServiceContent(state, selectedService, Number(screen.width), logCaches, getActiveEmbeddedTerminalServices()),
            ) || dirty;
            lastRenderedSelectionKey = buildServiceRenderKey(
              state,
              selectedService,
              Number(screen.width),
              Number(screen.height),
              logCacheVersion,
              getActiveEmbeddedTerminalServices(),
            );
          }
          if (selectedService === serviceName) {
            dirty = applyLogContent(serviceName) || dirty;
            dirty = renderFooter() || dirty;
          }

          if (dirty) {
            requestScreenRender(false);
          }
        })
        .finally(() => {
          logRefreshes.delete(serviceName);
          if (pendingRefreshes.has(serviceName)) {
            pendingRefreshes.delete(serviceName);
            refreshLogCache(serviceName);
          }
        });

      logRefreshes.set(serviceName, refresh);
    };

    const refreshLogCaches = (priorityService: string | null) => {
      if (priorityService) {
        refreshLogCache(priorityService);
      }

      const now = Date.now();
      if (now - lastBackgroundLogRefreshAt < BACKGROUND_LOG_REFRESH_MS) {
        return;
      }

      lastBackgroundLogRefreshAt = now;
      for (const serviceName of serviceNames) {
        if (serviceName !== priorityService) {
          refreshLogCache(serviceName);
        }
      }
    };

    const ensureSelectedVisible = (selectedLine: number): boolean => {
      const visibleHeight = Math.max(Number(servicesBox.height) || 1, 1);
      const currentScroll = servicesBox.getScroll();

      if (selectedLine < currentScroll) {
        const nextScroll = Math.max(selectedLine - 1, 0);
        if (nextScroll === currentScroll) {
          return false;
        }

        servicesBox.setScroll(nextScroll);
        return true;
      }

      if (selectedLine > currentScroll + visibleHeight - 1) {
        const nextScroll = Math.max(selectedLine - visibleHeight + 2, 0);
        if (nextScroll === currentScroll) {
          return false;
        }

        servicesBox.setScroll(nextScroll);
        return true;
      }

      return false;
    };

    const applyServiceRender = (serviceRender: ServiceRenderResult): boolean => {
      lastServiceRender = serviceRender;
      serviceNames = serviceRender.serviceNames;
      const failedText = serviceRender.failedCount > 0 ? ` / ${serviceRender.failedCount} failed` : "";
      const frameLabel = ` Services ${serviceRender.runningCount}/${serviceRender.totalServices} running${failedText} `;
      let changed = false;

      if (frameLabel !== lastServicesFrameLabel) {
        servicesFrameBox.setLabel(frameLabel);
        lastServicesFrameLabel = frameLabel;
        changed = true;
      }
      if (serviceRender.headerContent !== lastServicesHeaderContent) {
        servicesHeaderBox.setContent(serviceRender.headerContent);
        lastServicesHeaderContent = serviceRender.headerContent;
        changed = true;
      }
      if (serviceRender.content !== lastServicesContent) {
        servicesBox.setContent(serviceRender.content);
        lastServicesContent = serviceRender.content;
        changed = true;
      }

      return ensureSelectedVisible(serviceRender.selectedLine) || changed;
    };

    const render = async () => {
      if (mode === "terminal") {
        return;
      }

      if (rendering) {
        renderPending = true;
        return;
      }

      rendering = true;
      try {
        let dirty = applyPaneLayout();
        refreshResourceMetrics();
        state = await readSupervisorState(config.project);
        if (!state) {
          header.show();
          footer.show();
          dirty = renderHeader("Supervisor is not running.") || dirty;
          lastServiceRender = null;
          servicesHeaderBox.setContent("");
          servicesBox.setContent("");
          lastServicesHeaderContent = "";
          lastServicesContent = "";
          servicesFrameBox.hide();
          servicesHeaderBox.hide();
          servicesBox.hide();
          logBox.hide();
          logBox.setContent("Supervisor is not running.");
          lastLogContent = "Supervisor is not running.";
          dirty = renderFooter() || dirty;
          if (dirty) {
            requestScreenRender();
          }
          return;
        }

        const nextSelected =
          selectedService && state.services[selectedService]
            ? selectedService
            : Object.keys(state.services)[0] ?? null;
        const selectedChanged = nextSelected !== selectedService;
        selectedService = nextSelected;

        const activeEmbeddedTerminalServices = getActiveEmbeddedTerminalServices();
        const serviceRenderKey = buildServiceRenderKey(
          state,
          selectedService,
          Number(screen.width),
          Number(screen.height),
          logCacheVersion,
          activeEmbeddedTerminalServices,
        );
        let currentServiceRender = lastServiceRender;
        if (serviceRenderKey !== lastRenderedSelectionKey || !currentServiceRender) {
          currentServiceRender = buildServiceContent(
            state,
            selectedService,
            Number(screen.width),
            logCaches,
            activeEmbeddedTerminalServices,
          );
          dirty = applyServiceRender(currentServiceRender) || dirty;
          lastRenderedSelectionKey = serviceRenderKey;
        }

        const failedSummary = currentServiceRender.failedCount > 0 ? ` - ${currentServiceRender.failedCount} failed` : "";
        const serviceSummary = `${currentServiceRender.runningCount}/${currentServiceRender.totalServices} running${failedSummary}`;
        dirty = renderHeader(serviceSummary) || dirty;

        const selected = getSelectedService();
        if (!selected) {
          dirty = applyLogContent(null) || dirty;
        } else {
          if (selectedChanged) {
            logPinnedToBottom = true;
          }

          dirty = applyLogContent(selected.service) || dirty;
        }

        header.show();
        footer.show();
        servicesFrameBox.show();
        servicesHeaderBox.show();
        servicesBox.show();
        logBox.show();

        refreshLogCaches(selected?.service ?? null);
        dirty = renderFooter() || dirty;
        if (dirty) {
          requestScreenRender();
        }
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
        logPinnedToBottom = true;
        let dirty = applyServiceRender(
          buildServiceContent(state, selectedService, Number(screen.width), logCaches, getActiveEmbeddedTerminalServices()),
        );
        dirty = applyLogContent(selectedService) || dirty;
        if (selectedService) {
          refreshLogCache(selectedService);
          for (let i = 1; i <= 2; i++) {
            const prefetchIndex = nextIndex + direction * i;
            if (prefetchIndex >= 0 && prefetchIndex < serviceNames.length) {
              const prefetchService = serviceNames[prefetchIndex];
              if (prefetchService) refreshLogCache(prefetchService);
            }
          }
        }
        dirty = renderFooter() || dirty;
        if (dirty) {
          requestScreenRender(true);
        }
      }
    };

    const clearServiceLogCache = (serviceName: string, logPath: string) => {
      logCaches.set(serviceName, {
        content: "",
        mtimeMs: Date.now(),
        pathname: logPath,
        size: 0,
      });
      logCacheVersion += 1;
      logPinnedToBottom = true;
      if (state) {
        applyServiceRender(
          buildServiceContent(state, selectedService, Number(screen.width), logCaches, getActiveEmbeddedTerminalServices()),
        );
        lastRenderedSelectionKey = buildServiceRenderKey(
          state,
          selectedService,
          Number(screen.width),
          Number(screen.height),
          logCacheVersion,
          getActiveEmbeddedTerminalServices(),
        );
      }
      applyLogContent(serviceName);
      renderFooter();
      requestScreenRender(true);
    };

    const openServiceActionModal = ({
      cancelMessage,
      confirmLabel,
      initialValue,
      inputLabel,
      message,
      title,
      validate,
      onConfirm,
    }: {
      cancelMessage: string;
      confirmLabel: string;
      initialValue?: string;
      inputLabel?: string;
      message: string;
      onConfirm(value: string): void;
      title: string;
      validate?(value: string): string | null;
    }) => {
      if (actionModal) {
        actionModal.destroy({ notify: false, render: false });
      }

      mode = "modal";
      actionModal = openActionModal({
        confirmLabel,
        initialValue,
        inputLabel,
        message,
        onCancel: () => {
          lastModalInteractionAt = Date.now();
          actionModal = null;
          mode = "navigate";
          servicesBox.focus();
          setFooterMessage("info", cancelMessage);
          renderFooter();
          requestScreenRender(true);
        },
        onConfirm: (value) => {
          lastModalInteractionAt = Date.now();
          actionModal = null;
          mode = "navigate";
          servicesBox.focus();
          onConfirm(value);
        },
        screen,
        title,
        validate,
      });
    };

    const openShortcutHelpModal = () => {
      if (actionModal) {
        actionModal.destroy({ notify: false, render: false });
      }

      const selected = getSelectedService();
      const shortcutItems = mode === "terminal"
        ? [
          { label: "[Esc] Hide terminal", priority: 100 },
          { label: "[?] Help", priority: 99 },
        ]
        : mode === "navigate"
          ? buildShortcutItems(
            selected,
            selectedHasLogs(),
            hasActiveEmbeddedTerminalSession(selected?.service ?? null),
          )
          : [];

      mode = "modal";
      actionModal = openActionModal({
        closeKeys: ["?", "enter", "escape", "q"],
        message: buildShortcutHelpContent(shortcutItems),
        mode: "info",
        onCancel: () => {
          lastModalInteractionAt = Date.now();
          actionModal = null;
          mode = "navigate";
          servicesBox.focus();
          renderFooter();
          requestScreenRender(true);
        },
        onConfirm: () => {},
        screen,
        title: "Shortcuts",
      });
    };

    const startBranchPrompt = () => {
      if (!guardSelectedServiceIdle("switching branch")) {
        return;
      }

      const selected = getSelectedService();
      if (!selected?.isGit) {
        setFooterMessage("warning", "Selected service is not a git repository.");
        void render();
        return;
      }

      if (selected.status !== "stopped" && selected.status !== "failed" && selected.status !== "running") {
        setFooterMessage("warning", `${selected.service} cannot switch branch from status ${selected.status}.`);
        void render();
        return;
      }

      openServiceActionModal({
        cancelMessage: "Branch change cancelled.",
        confirmLabel: "Checkout",
        initialValue: "",
        inputLabel: "Branch",
        message: `Switch ${selected.service} to another branch.`,
        onConfirm: (value) => {
          const targetBranch = value.trim();
          clearServiceLogCache(selected.service, selected.logPath);
          setFooterMessage("info", `Running checkout for ${selected.service}...`);
          renderFooter();
          requestScreenRender(true);
          void runServiceAction(selected.service, "checkout", async () => {
            const response = await checkoutSupervisorBranch(config, selected.service, targetBranch);
            if (response.ok && state?.services[selected.service]) {
              state.services[selected.service].branch = targetBranch;
              state.services[selected.service].isGit = true;
              state.updatedAt = new Date().toISOString();
            }
            return response;
          }, `Checkout ${targetBranch} failed.`);
        },
        title: `Branch: ${selected.service}`,
        validate: (value) => value.trim() ? null : "Branch name is required.",
      });
    };

    const pullSelectedBranch = async () => {
      if (!guardSelectedServiceIdle("pulling")) {
        return;
      }

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

      if (selected.status !== "stopped" && selected.status !== "failed" && selected.status !== "running") {
        setFooterMessage("warning", `${selected.service} cannot pull from status ${selected.status}.`);
        void render();
        return;
      }

      openServiceActionModal({
        cancelMessage: "Pull cancelled.",
        confirmLabel: "Pull",
        message: `Run git pull --rebase for ${selected.service}?`,
        onConfirm: () => {
          clearServiceLogCache(selected.service, selected.logPath);
          setFooterMessage("info", `Running git pull for ${selected.service}...`);
          renderFooter();
          requestScreenRender(true);
          void runServiceAction(selected.service, "pull", async () => {
            const response = await pullSupervisorBranch(config, selected.service);
            const selectedResult = response.results?.find((result) => result.service === selected.service);
            if (selectedResult?.ok && state?.services[selected.service]) {
              state.services[selected.service].isGit = true;
              state.updatedAt = new Date().toISOString();
            }
            return response;
          }, `Pull ${selected.service} failed.`);
        },
        title: `Pull: ${selected.service}`,
      });
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

    const openEmbeddedTerminalForSelectedService = () => {
      const service = getSelectedService();
      if (!service) {
        setFooterMessage("warning", "No service selected.");
        void render();
        return;
      }

      hideVisibleEmbeddedTerminal({ notify: false, render: false });

      const existingSession = embeddedTerminalSessions.get(service.service);
      if (existingSession) {
        if (existingSession.isAlive()) {
          visibleEmbeddedTerminalService = service.service;
          mode = "terminal";
          existingSession.show();
          setFooterMessage("info", `Terminal resumed for ${service.service} in ${service.cwd}.`);
          renderFooter();
          requestScreenRender(true);
          return;
        }

        destroyEmbeddedTerminalSession(service.service, {
          kill: false,
          notify: false,
          render: false,
        });
      }

      try {
        mode = "terminal";
        visibleEmbeddedTerminalService = service.service;
        const session = openEmbeddedTerminal({
          cwd: service.cwd,
          screen,
          serviceName: service.service,
          onEscapeInput: () => {
            lastTerminalEscapeAt = Date.now();
          },
          onHide: () => {
            if (visibleEmbeddedTerminalService === service.service) {
              visibleEmbeddedTerminalService = null;
            }
            mode = "navigate";
            servicesBox.focus();
            setFooterMessage("info", `Terminal hidden for ${service.service}. Press t to resume.`);
            void render();
          },
        });
        embeddedTerminalSessions.set(service.service, session);
      } catch (error) {
        mode = "navigate";
        visibleEmbeddedTerminalService = null;
        setFooterMessage(
          "error",
          `Unable to open terminal for ${service.service}: ${getErrorMessage(error)}`,
        );
        void render();
        return;
      }

      setFooterMessage("info", `Terminal open for ${service.service} in ${service.cwd}.`);
      renderFooter();
      requestScreenRender(true);
    };

    const killEmbeddedTerminalSessionForSelectedService = () => {
      const service = getSelectedService();
      if (!service) {
        setFooterMessage("warning", "No service selected.");
        void render();
        return;
      }

      const session = embeddedTerminalSessions.get(service.service);
      if (!session || !session.isAlive()) {
        if (session) {
          destroyEmbeddedTerminalSession(service.service, {
            kill: false,
            notify: false,
            render: false,
          });
        }

        setFooterMessage("warning", `${service.service} has no active terminal session.`);
        void render();
        return;
      }

      destroyEmbeddedTerminalSession(service.service, {
        kill: true,
        notify: false,
        render: false,
      });
      mode = "navigate";
      servicesBox.focus();
      setFooterMessage("success", `Killed terminal for ${service.service}.`);
      void render();
    };

    const scrollLogs = (offset: number) => {
      logBox.scroll(offset);
      logPinnedToBottom = logBox.getScrollPerc() >= 98;
      requestScreenRender();
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

    const runServiceAction = async (
      serviceName: string,
      actionName: string,
      action: () => Promise<SupervisorResponse>,
      fallback: string,
    ) => {
      if (pendingServiceActions.has(serviceName)) {
        setFooterMessage("warning", `${serviceName} is busy with ${pendingServiceActions.get(serviceName)}.`);
        renderFooter();
        requestScreenRender(true);
        return;
      }

      pendingServiceActions.set(serviceName, actionName);
      if (state?.services[serviceName]) {
        if (actionName === "install") {
          state.services[serviceName].status = "installing";
        } else if (actionName === "pull" || actionName === "checkout" || actionName === "restart") {
          state.services[serviceName].status = "restarting";
        } else if (actionName === "start") {
          state.services[serviceName].status = "starting";
        } else if (actionName === "stop") {
          state.services[serviceName].status = "stopping";
        }
        applyServiceRender(
          buildServiceContent(state, selectedService, Number(screen.width), logCaches, getActiveEmbeddedTerminalServices()),
        );
        applyLogContent(selectedService);
      }
      renderFooter();
      requestScreenRender(true);

      try {
        await runAction(action, fallback);
      } finally {
        pendingServiceActions.delete(serviceName);
        renderFooter();
        requestScreenRender(true);
      }
    };

    const runSelectedServiceAction = async (
      action: "clear-logs" | "install" | "restart" | "start" | "stop",
    ) => {
      if (!guardSelectedServiceIdle(action)) {
        return;
      }

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

      if (
        action === "install" &&
        selected.status !== "stopped" &&
        selected.status !== "failed" &&
        selected.status !== "running"
      ) {
        setFooterMessage("warning", `${selected.service} cannot install from status ${selected.status}.`);
        void render();
        return;
      }

      if (action === "restart" && selected.status !== "running" && selected.status !== "failed") {
        setFooterMessage("warning", `${selected.service} cannot restart from status ${selected.status}.`);
        void render();
        return;
      }

      if (action === "stop" && selected.status !== "running" && selected.status !== "starting" && selected.status !== "failed") {
        setFooterMessage("warning", `${selected.service} cannot be killed from status ${selected.status}.`);
        void render();
        return;
      }

      if (action === "clear-logs" && !selectedHasLogs()) {
        setFooterMessage("warning", `${selected.service} has no logs to clear.`);
        void render();
        return;
      }

      if (action === "install") {
        openServiceActionModal({
          cancelMessage: "Install cancelled.",
          confirmLabel: "Install",
          message: selected.status === "running"
            ? `Install dependencies for ${selected.service}? The service will stop first and restart after success.`
            : `Install dependencies for ${selected.service}?`,
          onConfirm: () => {
            clearServiceLogCache(selected.service, selected.logPath);
            setFooterMessage("info", `Installing dependencies for ${selected.service}...`);
            renderFooter();
            requestScreenRender(true);
            void runServiceAction(selected.service, action, async () => {
              const response = await controlSupervisor(config, action, [selected.service]);
              const selectedResult = response.results?.find((result) => result.service === selected.service);
              if (selectedResult?.ok && state?.services[selected.service]) {
                state.services[selected.service].status = "installing";
                state.updatedAt = new Date().toISOString();
              }

              if (selectedResult?.ok) {
                logCaches.delete(selected.service);
                applyLogContent(selected.service);
                renderFooter();
              }
              return response;
            }, `Install ${selected.service} failed.`);
          },
          title: `Install: ${selected.service}`,
        });
        return;
      }

      const prefix =
        action === "start"
          ? `Start ${selected.service}`
          : action === "restart"
            ? `Restart ${selected.service}`
            : action === "clear-logs"
              ? `Clear logs for ${selected.service}`
              : `Kill ${selected.service}`;
      if (action === "start" || action === "restart") {
        clearServiceLogCache(selected.service, selected.logPath);
      }
      await runServiceAction(selected.service, action, async () => {
        const response = await controlSupervisor(config, action, [selected.service]);
        const selectedResult = response.results?.find((result) => result.service === selected.service);
        if (selectedResult?.ok && state?.services[selected.service]) {
          if (action === "start") {
            state.services[selected.service].status = "starting";
          } else if (action === "restart") {
            state.services[selected.service].status = "restarting";
          } else if (action === "stop") {
            state.services[selected.service].status = "stopped";
          }
          state.updatedAt = new Date().toISOString();
        }

        if (selectedResult?.ok && (action === "start" || action === "restart")) {
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

    const closeScreen = () => {
      actionModal?.destroy({ notify: false, render: false });
      actionModal = null;
      destroyAllEmbeddedTerminalSessions({ notify: false, render: false });
      screen.destroy();
      resolve();
    };

    const requestCloseScreen = () => {
      const liveEmbeddedTerminalCount = getLiveEmbeddedTerminalCount();
      if (liveEmbeddedTerminalCount === 0) {
        closeScreen();
        return;
      }

      openServiceActionModal({
        cancelMessage: "Exit cancelled.",
        confirmLabel: "Exit UI",
        message: buildEmbeddedTerminalExitMessage(liveEmbeddedTerminalCount),
        onConfirm: () => {
          destroyAllEmbeddedTerminalSessions({ notify: false, render: false });
          closeScreen();
        },
        title: "Exit UI",
      });
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

    screen.key(["up"], () => {
      if (mode === "navigate") {
        moveSelection(-1);
      }
    });
    screen.key(["down"], () => {
      if (mode === "navigate") {
        moveSelection(1);
      }
    });
    screen.key(["pageup"], () => {
      if (mode === "navigate") {
        scrollLogs(-12);
      }
    });
    screen.key(["pagedown"], () => {
      if (mode === "navigate") {
        scrollLogs(12);
      }
    });
    screen.key(["home"], () => {
      if (mode !== "navigate") {
        return;
      }
      logPinnedToBottom = false;
      logBox.setScroll(0);
      requestScreenRender();
    });
    screen.key(["end"], () => {
      if (mode !== "navigate") {
        return;
      }
      logPinnedToBottom = true;
      logBox.setScrollPerc(100);
      requestScreenRender();
    });
    screen.key(["v"], () => {
      if (mode !== "navigate") {
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
    screen.key(["i"], () => {
      if (mode === "navigate") {
        void runSelectedServiceAction("install");
      }
    });
    screen.key(["s"], () => {
      if (mode === "navigate") {
        void runSelectedServiceAction("start");
      }
    });
    screen.key(["k"], () => {
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
    screen.key(["x"], () => {
      if (mode === "navigate") {
        killEmbeddedTerminalSessionForSelectedService();
      }
    });
    screen.key(["?"], () => {
      if (isEmbeddedTerminalVisible()) {
        return;
      }

      if (mode === "navigate") {
        openShortcutHelpModal();
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
        requestScreenRender();
      });
      child.unref();
      setFooterMessage("info", `Opening ${service.cwd} in ${editor}...`);
      renderFooter();
      requestScreenRender();
    });
    screen.key(["t"], () => {
      if (mode === "navigate") {
        openEmbeddedTerminalForSelectedService();
      }
    });
    screen.key(["enter"], () => {
      if (mode === "modal") {
        return;
      }

      if (mode === "navigate" && Date.now() - lastModalInteractionAt < 75) {
        return;
      }

      if (mode === "navigate") {
        void runSelectedServiceAction("start");
      }
    });
    screen.key(["q"], () => {
      if (mode === "navigate") {
        requestCloseScreen();
      }
    });
    screen.key(["C-c"], () => {
      if (mode !== "terminal") {
        requestCloseScreen();
      }
    });
    screen.key(["escape"], () => {
      if (Date.now() - lastTerminalEscapeAt < 75) {
        return;
      }

      if (mode === "terminal") {
        lastTerminalEscapeAt = Date.now();
        hideVisibleEmbeddedTerminal({ render: false });
        return;
      }

      if (mode === "modal") {
        return;
      }

      if (Date.now() - lastModalInteractionAt < 75) {
        return;
      }

      requestCloseScreen();
    });
    screen.on("keypress", (ch, key) => {
      if (mode !== "modal") {
        return;
      }
      if (actionModal?.handleKeypress(ch ?? undefined, key)) {
        lastModalInteractionAt = Date.now();
      }
    });
    screen.on("resize", () => {
      actionModal?.resize();
      for (const session of embeddedTerminalSessions.values()) {
        if (session.isVisible()) {
          session.resize();
        }
      }
      void render();
    });

    const interval = setInterval(() => {
      void render();
    }, SCREEN_POLL_MS);

    screen.on("destroy", () => {
      screenClosed = true;
      actionModal?.destroy({ notify: false, render: false });
      actionModal = null;
      destroyAllEmbeddedTerminalSessions({ notify: false, render: false });
      visibleEmbeddedTerminalService = null;
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      clearInterval(interval);
    });

    void render();
  });
}
