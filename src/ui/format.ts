/**
 * Formats an ISO timestamp as a short, human-readable age (e.g. "5s", "3m", "2h", "4d").
 * Returns "--" for missing or unparseable values.
 */
export function formatRelativeAge(value: string | null, now = Date.now()): string {
  if (!value) {
    return "--";
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "--";
  }

  const seconds = Math.max(Math.floor((now - parsed) / 1000), 0);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}
