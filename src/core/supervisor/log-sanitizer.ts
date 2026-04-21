const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const ANSI_CONTROL_REGEX = /\x1b\[[0-9;]*[ABCDEFGHJKSTfsu]/g;
const LOG_NOISE_PATTERNS = [
  /^gitstatus failed to initialize$/i,
  /^\[ERROR\]: gitstatus failed to initialize\.$/i,
  /^setopt: can't change option: monitor$/i,
  /^setopt: can't change option: zle$/i,
  /^\(anon\):setopt:\d+: can't change option: monitor$/i,
  /^\(eval\):\d+: can't change option: zle$/i,
  /^\[oh-my-zsh\] Insecure completion-dependent directories detected:/i,
  /^compaudit \| xargs chmod g-w,o-w$/i,
  /^There are insecure directories:/i,
  /^Add the following parameter to .* for extra diagnostics on error:/i,
  /^Restart .* to retry gitstatus initialization:/i,
  /^exec zsh$/i,
  /^GITSTATUS_LOG_LEVEL=DEBUG$/i,
  /^\(node:\d+\) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\.$/i,
  /^\(Use `node --trace-warnings .*` to show where the warning was created\)$/i,
];

function stripAnsi(value: string): string {
  return value.replace(ANSI_REGEX, "");
}

function shouldDropLogLine(line: string): boolean {
  const normalized = stripAnsi(line).trim();
  if (!normalized) {
    return false;
  }

  return LOG_NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function sanitizeLogChunk(chunk: string): string {
  const normalized = chunk
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0004\b\b/g, "")
    .replace(ANSI_CONTROL_REGEX, "");

  const parts = normalized.split("\n");
  const sanitized = parts.filter((line) => !shouldDropLogLine(line)).join("\n");

  if (!sanitized) {
    return "";
  }

  if (normalized.endsWith("\n") && !sanitized.endsWith("\n")) {
    return `${sanitized}\n`;
  }

  return sanitized;
}
