import { bold, fg, muted, truncate, UI_THEME } from "./theme";

export const HEADER_HEIGHT = 4;
export const FOOTER_HEIGHT = 4;

const SERVICES_MIN_HEIGHT = 6;
const SERVICES_MAX_HEIGHT = 18;

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

function getBodyHeight(screenHeight: number): number {
  return Math.max(screenHeight - HEADER_HEIGHT - FOOTER_HEIGHT, 1);
}

export function getSupervisorPaneLayout(screenWidth: number, screenHeight = 32): SupervisorPaneLayout {
  const width = Math.max(Math.floor(screenWidth), 40);
  const height = Math.max(Math.floor(screenHeight), HEADER_HEIGHT + FOOTER_HEIGHT + 2);
  const bodyHeight = getBodyHeight(height);
  const logMinimumHeight = bodyHeight >= 10 ? 5 : 1;
  const preferredServicesHeight = Math.round(bodyHeight * 0.40);
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
