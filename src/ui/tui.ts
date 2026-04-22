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
const SCREEN_POLL_MS = 250;

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
            lastRenderedSelectionKey = buildServiceRenderKey(
              state,
              selectedService,
              Number(screen.width),
              Number(screen.height),
              logCacheVersion,
            );
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
