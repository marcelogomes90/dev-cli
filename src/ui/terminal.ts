import { spawn, type ChildProcess } from "node:child_process";

export interface TerminalLaunchCommand {
  args: string[];
  command: string;
  cwd: string;
  label: string;
}

interface TerminalLaunchOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  windowTitle?: string;
}

type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; detached: true; stdio: "ignore" },
) => ChildProcess;

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildShellCdCommand(cwd: string): string {
  return `cd ${quotePosix(cwd)}`;
}

function detectTerminalIds(env: NodeJS.ProcessEnv): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) {
      ids.push(id);
    }
  };
  const termProgram = env.TERM_PROGRAM?.toLowerCase();
  const bundleId = env.__CFBundleIdentifier?.toLowerCase();
  const term = env.TERM?.toLowerCase();

  if (env.TMUX) {
    add("tmux");
  }

  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET || bundleId === "org.alacritty") {
    add("alacritty");
  }

  if (env.WEZTERM_PANE || env.WEZTERM_EXECUTABLE || termProgram === "wezterm" || bundleId === "com.github.wez.wezterm") {
    add("wezterm");
  }

  if (env.KITTY_WINDOW_ID || env.KITTY_LISTEN_ON || term === "xterm-kitty" || bundleId === "net.kovidgoyal.kitty") {
    add("kitty");
  }

  if (env.GHOSTTY_RESOURCES_DIR || bundleId === "com.mitchellh.ghostty") {
    add("ghostty");
  }

  if (termProgram === "iterm.app" || bundleId === "com.googlecode.iterm2") {
    add("iterm");
  }

  if (termProgram === "apple_terminal" || bundleId === "com.apple.terminal") {
    add("terminal-app");
  }

  if (env.WT_SESSION) {
    add("windows-terminal");
  }

  if (env.KONSOLE_VERSION) {
    add("konsole");
  }

  if (env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE) {
    add("gnome-terminal");
  }

  return ids;
}

function createTerminalLaunchCommand(
  id: string,
  cwd: string,
  platform: NodeJS.Platform,
  windowTitle?: string,
): TerminalLaunchCommand | null {
  switch (id) {
    case "alacritty":
      return platform === "darwin"
        ? { args: ["-na", "Alacritty", "--args", "--working-directory", cwd], command: "open", cwd, label: "Alacritty" }
        : { args: ["--working-directory", cwd], command: "alacritty", cwd, label: "Alacritty" };
    case "ghostty":
      return platform === "darwin"
        ? { args: ["-na", "Ghostty", "--args", `--working-directory=${cwd}`], command: "open", cwd, label: "Ghostty" }
        : { args: [`--working-directory=${cwd}`], command: "ghostty", cwd, label: "Ghostty" };
    case "gnome-terminal":
      return { args: ["--working-directory", cwd], command: "gnome-terminal", cwd, label: "GNOME Terminal" };
    case "iterm": {
      const script = [
        'tell application "iTerm"',
        "  activate",
        "  create window with default profile",
        "  tell current session of current window",
        `    write text ${quoteAppleScriptString(buildShellCdCommand(cwd))}`,
        "  end tell",
        "end tell",
      ].join("\n");
      return { args: ["-e", script], command: "osascript", cwd, label: "iTerm" };
    }
    case "kitty":
      return { args: ["--directory", cwd], command: "kitty", cwd, label: "Kitty" };
    case "konsole":
      return { args: ["--workdir", cwd], command: "konsole", cwd, label: "Konsole" };
    case "terminal-app": {
      const script = [
        'tell application "Terminal"',
        "  activate",
        `  do script ${quoteAppleScriptString(buildShellCdCommand(cwd))}`,
        "end tell",
      ].join("\n");
      return { args: ["-e", script], command: "osascript", cwd, label: "Terminal" };
    }
    case "tmux": {
      const args = ["new-window", "-c", cwd];
      if (windowTitle) {
        args.push("-n", windowTitle);
      }
      return { args, command: "tmux", cwd, label: "tmux" };
    }
    case "wezterm":
      return { args: ["start", "--cwd", cwd], command: "wezterm", cwd, label: "WezTerm" };
    case "windows-cmd":
      return {
        args: ["/c", "start", "", "cmd.exe", "/K", `cd /d ${quoteWindowsCmdArg(cwd)}`],
        command: "cmd.exe",
        cwd,
        label: "Command Prompt",
      };
    case "windows-terminal":
      return { args: ["-w", "new", "-d", cwd], command: "wt", cwd, label: "Windows Terminal" };
    case "xfce4-terminal":
      return { args: ["--working-directory", cwd], command: "xfce4-terminal", cwd, label: "XFCE Terminal" };
    case "x-terminal-emulator":
      return { args: [], command: "x-terminal-emulator", cwd, label: "x-terminal-emulator" };
    case "xterm":
      return { args: [], command: "xterm", cwd, label: "xterm" };
    default:
      return null;
  }
}

export function buildTerminalLaunchCommands(
  cwd: string,
  { env = process.env, platform = process.platform, windowTitle }: TerminalLaunchOptions = {},
): TerminalLaunchCommand[] {
  const ids = detectTerminalIds(env);

  if (platform === "darwin") {
    ids.push("terminal-app", "iterm", "alacritty", "wezterm", "kitty", "ghostty");
  } else if (platform === "win32") {
    ids.push("windows-terminal", "windows-cmd");
  } else {
    ids.push(
      "x-terminal-emulator",
      "gnome-terminal",
      "konsole",
      "xfce4-terminal",
      "alacritty",
      "wezterm",
      "kitty",
      "ghostty",
      "xterm",
    );
  }

  const commands: TerminalLaunchCommand[] = [];
  for (const id of ids) {
    const command = createTerminalLaunchCommand(id, cwd, platform, windowTitle);
    if (
      command &&
      !commands.some((candidate) => candidate.command === command.command && candidate.args.join("\0") === command.args.join("\0"))
    ) {
      commands.push(command);
    }
  }

  return commands;
}

export async function launchTerminal(
  commands: TerminalLaunchCommand[],
  spawnImpl: SpawnLike = spawn,
): Promise<{ command?: TerminalLaunchCommand; error?: NodeJS.ErrnoException; ok: boolean }> {
  let lastError: NodeJS.ErrnoException | undefined;

  for (const command of commands) {
    const result = await new Promise<{ error?: NodeJS.ErrnoException; ok: boolean }>((resolve) => {
      let settled = false;
      const settle = (result: { error?: NodeJS.ErrnoException; ok: boolean }) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      try {
        const child = spawnImpl(command.command, command.args, {
          cwd: command.cwd,
          detached: true,
          stdio: "ignore",
        });
        child.once("spawn", () => {
          child.unref();
          settle({ ok: true });
        });
        child.once("error", (error) => settle({ error: error as NodeJS.ErrnoException, ok: false }));
      } catch (error) {
        settle({ error: error as NodeJS.ErrnoException, ok: false });
      }
    });

    if (result.ok) {
      return { command, ok: true };
    }

    lastError = result.error;
  }

  return { error: lastError, ok: false };
}
