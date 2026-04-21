export type MessageTone = "error" | "info" | "success" | "warning";

export const UI_THEME = {
  accent: "cyan",
  border: "white",
  danger: "red",
  logAccent: "magenta",
  muted: "white",
  steady: "green",
  tableHeader: "yellow",
  text: "white",
  warning: "yellow",
} as const;

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
      return "green-fg";
    case "warning":
      return "yellow-fg";
    case "error":
      return "red-fg";
    default:
      return "cyan-fg";
  }
}
