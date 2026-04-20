export function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
