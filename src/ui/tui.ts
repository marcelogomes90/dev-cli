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
import { buildHeaderContent, FOOTER_HEIGHT, getSupervisorPaneLayout, HEADER_HEIGHT } from "./layout";
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
import { buildServiceContent, buildShortcutLine, type ServiceRenderResult } from "./services";
import { buildTerminalLaunchCommands, launchTerminal } from "./terminal";
import { muted, toneTag, truncate, UI_THEME, type MessageTone } from "./theme";

export { buildHeaderContent, getSupervisorPaneLayout, type SupervisorPaneLayout } from "./layout";
export { buildLogViewerCommand, launchExternalLogViewer, type LogViewerCommand } from "./logs";
export { computeCpuPercent, formatResourceMetrics, parseDarwinMemoryUsage, type CpuSnapshot, type ResourceMetrics } from "./metrics";
export { buildServiceContent, buildShortcutLine, type ServiceRenderResult } from "./services";
export { buildTerminalLaunchCommands, launchTerminal, type TerminalLaunchCommand } from "./terminal";

type UiMode = "branchPrompt" | "navigate";

interface FooterMessage {
  text: string;
  tone: MessageTone;
}

const METRICS_REFRESH_MS = 1_000;
const SCREEN_POLL_MS = 500;
const SCREEN_RENDER_DEBOUNCE_MS = 16;
const BACKGROUND_LOG_REFRESH_MS = 2_000;

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
    ...serviceParts,
  ].join("|");
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
    let renderTimer: NodeJS.Timeout | null = null;
    let screenClosed = false;
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

    const setFooterMessage = (tone: MessageTone, text: string) => {
      footerMessage = { text, tone };
    };

    const requestScreenRender = (immediate = false) => {
      if (screenClosed) {
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
      const promptText =
        mode === "branchPrompt" && selected
          ? `Branch for ${selected.service}: ${branchInput || ""}_`
          : footerMessage.text;
      const message = promptText;
      const busyAction = getSelectedBusyAction();
      const tone = busyAction ? "warning" : footerMessage.tone;
      const shortcuts =
        mode === "branchPrompt"
          ? ""
          : busyAction
            ? `[↑/↓ j/k] Move | ${selected?.service} busy: ${busyAction} | [v] View logs | [q] Quit`
            : buildShortcutLine(selected, selectedHasLogs());
      const footerInset = Number(screen.width) > 48 ? 2 : 1;
      const inset = " ".repeat(footerInset);
      const availableWidth = Math.max(Number(screen.width) - 2 - footerInset * 2, 10);
      const content = `${inset}{${toneTag(tone)}}${truncate(message, availableWidth).trimEnd()}{/${toneTag(tone)}}\n${inset}${muted(truncate(shortcuts, availableWidth).trimEnd())}`;
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
            dirty = applyServiceRender(buildServiceContent(state, selectedService, Number(screen.width), logCaches)) || dirty;
            lastRenderedSelectionKey = buildServiceRenderKey(
              state,
              selectedService,
              Number(screen.width),
              Number(screen.height),
              logCacheVersion,
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

        const serviceRenderKey = buildServiceRenderKey(
          state,
          selectedService,
          Number(screen.width),
          Number(screen.height),
          logCacheVersion,
        );
        let currentServiceRender = lastServiceRender;
        if (serviceRenderKey !== lastRenderedSelectionKey || !currentServiceRender) {
          currentServiceRender = buildServiceContent(state, selectedService, Number(screen.width), logCaches);
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
        let dirty = applyServiceRender(buildServiceContent(state, selectedService, Number(screen.width), logCaches));
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

      mode = "branchPrompt";
      branchInput = "";
      setFooterMessage("info", `Branch for ${selected.service}:`);
      renderFooter();
      requestScreenRender();
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

      await runServiceAction(selected.service, "pull", async () => {
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
      requestScreenRender();
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
        applyServiceRender(buildServiceContent(state, selectedService, Number(screen.width), logCaches));
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
      await runServiceAction(selected.service, action, async () => {
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

      if (pendingServiceActions.has(selected.service)) {
        branchInput = "";
        mode = "navigate";
        setFooterMessage("warning", `${selected.service} is busy with ${pendingServiceActions.get(selected.service)}.`);
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
        requestScreenRender();
        return;
      }

      branchInput = "";
      mode = "navigate";
      await runServiceAction(selected.service, "checkout", async () => {
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
      requestScreenRender();
    });
    screen.key(["end"], () => {
      if (mode === "branchPrompt") {
        return;
      }
      logPinnedToBottom = true;
      logBox.setScrollPerc(100);
      requestScreenRender();
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
        requestScreenRender();
      });
      child.unref();
      setFooterMessage("info", `Opening ${service.cwd} in ${editor}...`);
      renderFooter();
      requestScreenRender();
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
        requestScreenRender();
        return;
      }

      if (key.name === "enter" || key.name === "escape") {
        return;
      }

      if (ch && !key.ctrl && !key.meta) {
        branchInput += ch;
        renderFooter();
        requestScreenRender();
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
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      clearInterval(interval);
    });

    void render();
  });
}
