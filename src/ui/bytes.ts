interface FormatBytesOptions {
  largePrecision?: number;
}

export function formatBytes(value: number, _options: FormatBytesOptions = {}): string {
  const units = ["B", "K", "M", "G", "T"];
  let current = Math.max(value, 0);
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  return `${Math.round(current)}${units[unitIndex]}`;
}
