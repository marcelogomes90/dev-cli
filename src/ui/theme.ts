export type MessageTone = "error" | "info" | "success" | "warning";
export type TerminalThemeVariant = "dark" | "light";

export interface UiTheme {
  accent: string;
  border: string;
  buttonDisabledBackground: string;
  buttonDisabledText: string;
  buttonSelectedText: string;
  danger: string;
  logAccent: string;
  muted: string;
  steady: string;
  tableHeader: string;
  text: string;
  warning: string;
}

const DARK_THEME: UiTheme = {
  accent: "cyan",
  border: "white",
  buttonDisabledBackground: "#5f667a",
  buttonDisabledText: "black",
  buttonSelectedText: "black",
  danger: "red",
  logAccent: "magenta",
  muted: "white",
  steady: "green",
  tableHeader: "yellow",
  text: "white",
  warning: "yellow",
};

const LIGHT_THEME: UiTheme = {
  accent: "#005fcc",
  border: "#4b5563",
  buttonDisabledBackground: "#9ca3af",
  buttonDisabledText: "black",
  buttonSelectedText: "white",
  danger: "#b42318",
  logAccent: "#9c36b5",
  muted: "#4b5563",
  steady: "#1f7a46",
  tableHeader: "#005fcc",
  text: "#111827",
  warning: "#8a5a00",
};

const ANSI_16_RGB = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
] as const;

function getAnsiRgb(index: number): [number, number, number] | null {
  if (!Number.isFinite(index) || index < 0) {
    return null;
  }

  if (index < ANSI_16_RGB.length) {
    return ANSI_16_RGB[index] as [number, number, number];
  }

  if (index >= 16 && index <= 231) {
    const colorIndex = index - 16;
    const red = Math.floor(colorIndex / 36);
    const green = Math.floor((colorIndex % 36) / 6);
    const blue = colorIndex % 6;
    const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40);

    return [channel(red), channel(green), channel(blue)];
  }

  if (index >= 232 && index <= 255) {
    const shade = 8 + (index - 232) * 10;
    return [shade, shade, shade];
  }

  return null;
}

function parseColorFgbgBackground(colorFgbg: string | undefined): number | null {
  if (!colorFgbg) {
    return null;
  }

  const parts = colorFgbg
    .split(";")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));

  if (parts.length === 0) {
    return null;
  }

  return parts.at(-1) ?? null;
}

export function isLightTerminalBackground(colorIndex: number): boolean {
  const rgb = getAnsiRgb(colorIndex);
  if (!rgb) {
    return false;
  }

  const [red, green, blue] = rgb;
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return brightness >= 160;
}

export function detectTerminalThemeVariant(env: NodeJS.ProcessEnv = process.env): TerminalThemeVariant {
  const colorFgbgBackground = parseColorFgbgBackground(env.COLORFGBG);
  if (colorFgbgBackground !== null) {
    return isLightTerminalBackground(colorFgbgBackground) ? "light" : "dark";
  }

  const terminalProgramTheme = env.TERM_PROGRAM_THEME?.toLowerCase();
  if (terminalProgramTheme === "light") {
    return "light";
  }

  const iTermProfile = env.ITERM_PROFILE?.toLowerCase();
  if (iTermProfile?.includes("light")) {
    return "light";
  }

  return "dark";
}

export function resolveUiTheme(env: NodeJS.ProcessEnv = process.env): UiTheme {
  return detectTerminalThemeVariant(env) === "light" ? LIGHT_THEME : DARK_THEME;
}

export const UI_THEME = resolveUiTheme();

export function fg(color: string, value: string): string {
  return `{${color}-fg}${value}{/${color}-fg}`;
}

export function muted(value: string): string {
  return fg(UI_THEME.muted, value);
}

export function bold(value: string): string {
  return `{bold}${value}{/bold}`;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value.padEnd(max, " ");
  }

  return `${value.slice(0, Math.max(max - 1, 0))}…`;
}

export function toneTag(tone: MessageTone): string {
  switch (tone) {
    case "success":
      return `${UI_THEME.steady}-fg`;
    case "warning":
      return `${UI_THEME.warning}-fg`;
    case "error":
      return `${UI_THEME.danger}-fg`;
    default:
      return `${UI_THEME.accent}-fg`;
  }
}
