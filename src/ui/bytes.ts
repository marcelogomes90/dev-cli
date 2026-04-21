interface FormatBytesOptions {
  largePrecision?: number;
}

export function formatBytes(value: number, { largePrecision = 1 }: FormatBytesOptions = {}): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = Math.max(value, 0);
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : current >= 10 ? largePrecision : 1;
  return `${current.toFixed(precision)}${units[unitIndex]}`;
}
