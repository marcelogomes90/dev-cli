import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { execa } from "execa";

const projectRoot = process.cwd();
const cliEntry = path.join(projectRoot, "dist/index.js");
process.env.TMPDIR = "/tmp";
process.env.TMP = "/tmp";
process.env.TEMP = "/tmp";

test("dev --help lists core commands", async () => {
  const result = await execa("node", [cliEntry, "--help"], {
    cwd: projectRoot,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\bup\b/);
  assert.match(result.stdout, /\bui\b/);
  assert.match(result.stdout, /\bdown\b/);
  assert.match(result.stdout, /\bstatus\b/);
  assert.match(result.stdout, /\binit\b/);
  assert.doesNotMatch(result.stdout, /\bdoctor\b/);
  assert.doesNotMatch(result.stdout, /\brestart\b/);
});

class FakePrompter {
  constructor(answers) {
    this.answers = [...answers];
    this.messages = [];
  }

  nextAnswer() {
    assert.ok(this.answers.length > 0, "Missing answer for prompt.");
    return this.answers.shift();
  }

  async prompt(message) {
    this.messages.push(message);
    return this.nextAnswer();
  }

  async confirm(message) {
    this.messages.push(message);
    return this.nextAnswer();
  }

  async select(message) {
    this.messages.push(message);
    return this.nextAnswer();
  }

  async selectMany(message) {
    this.messages.push(message);
    return this.nextAnswer();
  }

  write(message) {
    this.messages.push(message);
  }

  close() {}
}

test("dev init fails without an interactive terminal", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-init-no-tty-"));
  const result = await execa("node", [cliEntry, "init"], {
    cwd: fixtureDir,
    input: "",
    reject: false,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /interactive terminal/);
});

test("runInitFlow writes a .devrc.yml with groups, services, and dependencies", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-init-config-"));
  const { runInitFlow } = await import(path.join(projectRoot, "dist/lib.js"));
  const prompter = new FakePrompter([
    "amigo",
    "",
    "infra",
    true,
    "api",
    false,
    "redis",
    "infra",
    ".",
    "docker run redis",
    "",
    true,
    true,
    "backend",
    "api",
    "./services/api",
    "yarn dev",
    "yarn",
    false,
    false,
    false,
    true,
    ["redis"],
    true,
  ]);

  const result = await runInitFlow({ cwd: fixtureDir, prompter });

  assert.equal(result.written, true);
  assert.equal(result.project, "amigo");

  const fileContent = await readFile(path.join(fixtureDir, ".devrc.yml"), "utf8");
  assert.match(fileContent, /^project: amigo/m);
  assert.match(fileContent, /infra:\n    services:\n      - redis/m);
  assert.match(fileContent, /api:\n    services:\n      - backend/m);
  assert.match(fileContent, /installCommand: yarn/m);
  assert.match(fileContent, /autostart: false/m);
  assert.match(fileContent, /dependsOn:\n      - redis/m);
  assert.doesNotMatch(fileContent, /session:/);
});

test("runInitFlow omits optional fields when they are not set", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-init-minimal-"));
  const { runInitFlow } = await import(path.join(projectRoot, "dist/lib.js"));
  const prompter = new FakePrompter([
    "solo",
    "",
    "api",
    false,
    "web",
    "api",
    ".",
    "npm run dev",
    "",
    true,
    false,
    true,
  ]);

  await runInitFlow({ cwd: fixtureDir, prompter });

  const fileContent = await readFile(path.join(fixtureDir, ".devrc.yml"), "utf8");
  assert.doesNotMatch(fileContent, /installCommand:/);
  assert.doesNotMatch(fileContent, /dependsOn:/);
  assert.doesNotMatch(fileContent, /autostart:/);
});

test("runInitFlow overwrites an existing config after confirmation", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-init-overwrite-"));
  await writeFile(path.join(fixtureDir, ".devrc.yml"), "project: old\n", "utf8");

  const { runInitFlow } = await import(path.join(projectRoot, "dist/lib.js"));
  const prompter = new FakePrompter([
    true,
    "new-project",
    "",
    "api",
    false,
    "worker",
    "api",
    ".",
    "node worker.js",
    "",
    true,
    false,
    true,
  ]);

  const result = await runInitFlow({ cwd: fixtureDir, prompter });

  assert.equal(result.written, true);
  const fileContent = await readFile(path.join(fixtureDir, ".devrc.yml"), "utf8");
  assert.match(fileContent, /^project: new-project/m);
});

test("runInitFlow returns without writing when overwrite is declined", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-init-skip-overwrite-"));
  const configPath = path.join(fixtureDir, ".devrc.yml");
  await writeFile(configPath, "project: old\n", "utf8");

  const { runInitFlow } = await import(path.join(projectRoot, "dist/lib.js"));
  const result = await runInitFlow({
    cwd: fixtureDir,
    prompter: new FakePrompter([false]),
  });

  assert.equal(result.written, false);
  assert.equal(await readFile(configPath, "utf8"), "project: old\n");
});

test("runInitFlow rejects duplicate names and required blanks before continuing", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-init-validation-"));
  const { runInitFlow } = await import(path.join(projectRoot, "dist/lib.js"));
  const prompter = new FakePrompter([
    "",
    "validated",
    "",
    "api",
    true,
    "api",
    "worker",
    false,
    "web",
    "api",
    "",
    ".",
    "",
    "npm run dev",
    "",
    true,
    true,
    "web",
    "job",
    "worker",
    ".",
    "node worker.js",
    "",
    true,
    false,
    true,
    ["job"],
    false,
    true,
  ]);

  await runInitFlow({ cwd: fixtureDir, prompter });

  const fileContent = await readFile(path.join(fixtureDir, ".devrc.yml"), "utf8");
  assert.match(fileContent, /^project: validated/m);
  assert.match(fileContent, /dependsOn:\n      - job/m);
  assert.ok(prompter.messages.some((message) => message.includes("This value is required.")));
  assert.ok(prompter.messages.some((message) => message.includes('Group "api" already exists.')));
  assert.ok(prompter.messages.some((message) => message.includes('Service "web" already exists.')));
});

test("runInitFlow fails when both config filenames already exist", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-init-conflict-"));
  await writeFile(path.join(fixtureDir, ".devrc.yml"), "project: one\n", "utf8");
  await writeFile(path.join(fixtureDir, ".devrc.yaml"), "project: two\n", "utf8");

  const { runInitFlow } = await import(path.join(projectRoot, "dist/lib.js"));

  await assert.rejects(
    runInitFlow({
      cwd: fixtureDir,
      prompter: new FakePrompter([]),
    }),
    /Found both .devrc.yml and .devrc.yaml/,
  );
});

test("loadProjectConfig resolves relative paths and defaults", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-config-"));
  await writeFile(
    path.join(fixtureDir, ".devrc.yml"),
    [
      "project: amigo",
      "groups:",
      "  api:",
      "    services: [api-main]",
      "services:",
      "  api-main:",
      "    cwd: ./services/api",
      "    command: yarn dev",
      "    installCommand: yarn",
      "    group: api",
    ].join("\n"),
  );

  const { loadProjectConfig } = await import(path.join(projectRoot, "dist/lib.js"));
  const config = await loadProjectConfig("amigo", fixtureDir);

  assert.equal(config.project, "amigo");
  assert.equal(config.session, "amigo");
  assert.equal(config.services["api-main"].autostart, true);
  assert.equal(config.services["api-main"].installCommand, "yarn");
  assert.equal(
    config.services["api-main"].cwd,
    path.join(fixtureDir, "services/api"),
  );
});

test("lib exports supervisor planning helpers", async () => {
  const {
    buildSupervisorPlan,
    DEPENDENCY_START_DELAY_MS,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = {
    configPath: "/tmp/.devrc.yml",
    groups: {
      infra: { services: ["redis"] },
      api: { services: ["api", "worker"] },
    },
    hooks: {},
    project: "amigo",
    rootDir: "/tmp",
    services: {
      redis: {
        autostart: true,
        command: "redis-server",
        cwd: "/tmp",
        dependsOn: [],
        env: {},
        group: "infra",
        installCommand: undefined,
        name: "redis",
      },
      api: {
        autostart: true,
        command: "node server.js",
        cwd: "/tmp",
        dependsOn: ["redis"],
        env: {},
        group: "api",
        installCommand: "yarn",
        name: "api",
      },
      worker: {
        autostart: true,
        command: "node worker.js",
        cwd: "/tmp",
        dependsOn: ["redis"],
        env: {},
        group: "api",
        installCommand: undefined,
        name: "worker",
      },
    },
    session: "amigo",
  };

  const plan = buildSupervisorPlan(config, ["api", "worker"]);

  assert.equal(plan.orderedServices[0], "redis");
  assert.deepEqual([...plan.orderedServices.slice(1)].sort(), ["api", "worker"]);
  assert.deepEqual(plan.startupPhases[0], ["redis"]);
  assert.deepEqual([...plan.startupPhases[1]].sort(), ["api", "worker"]);

  const operationalPlan = buildSupervisorPlan(config, ["api"], false);

  assert.deepEqual(operationalPlan.orderedServices, ["api"]);
  assert.deepEqual(operationalPlan.startupPhases, [["api"]]);
  assert.equal(DEPENDENCY_START_DELAY_MS, 5_000);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

async function runGit(cwd, args, reject = true) {
  return execa("git", args, {
    cwd,
    reject,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

async function waitFor(assertion, timeoutMs = 10_000, intervalMs = 50) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  throw lastError ?? new Error("Timed out waiting for condition.");
}

async function createSupervisorFixture(projectName) {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-supervisor-"));
  await writeFile(
    path.join(fixtureDir, "service.js"),
    [
      "console.log('boot');",
      "process.on('SIGTERM', () => {",
      "  setTimeout(() => process.exit(0), 250);",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  await writeFile(
    path.join(fixtureDir, ".devrc.yml"),
    [
      `project: ${projectName}`,
      "groups:",
      "  api:",
      "    services: [api]",
      "services:",
      "  api:",
      "    cwd: .",
      "    command: node ./service.js",
      "    group: api",
    ].join("\n"),
  );

  return fixtureDir;
}

async function createSupervisorDependencyFixture(projectName) {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-supervisor-deps-"));
  await writeFile(
    path.join(fixtureDir, "service.js"),
    [
      "console.log('boot');",
      "process.on('SIGTERM', () => {",
      "  setTimeout(() => process.exit(0), 250);",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  await writeFile(
    path.join(fixtureDir, ".devrc.yml"),
    [
      `project: ${projectName}`,
      "groups:",
      "  infra:",
      "    services: [redis]",
      "  api:",
      "    services: [api]",
      "services:",
      "  redis:",
      "    cwd: .",
      "    command: node ./service.js",
      "    group: infra",
      "  api:",
      "    cwd: .",
      "    command: node ./service.js",
      "    group: api",
      "    dependsOn: [redis]",
    ].join("\n"),
  );

  return fixtureDir;
}

async function createSupervisorParallelDependencyFixture(projectName) {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-supervisor-parallel-deps-"));
  await writeFile(
    path.join(fixtureDir, "service.js"),
    [
      "console.log('boot');",
      "process.on('SIGTERM', () => {",
      "  setTimeout(() => process.exit(0), 250);",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  await writeFile(
    path.join(fixtureDir, ".devrc.yml"),
    [
      `project: ${projectName}`,
      "groups:",
      "  infra:",
      "    services: [redis]",
      "  api:",
      "    services: [api, worker]",
      "services:",
      "  redis:",
      "    cwd: .",
      "    command: node ./service.js",
      "    group: infra",
      "  api:",
      "    cwd: .",
      "    command: node ./service.js",
      "    group: api",
      "    dependsOn: [redis]",
      "  worker:",
      "    cwd: .",
      "    command: node ./service.js",
      "    group: api",
      "    dependsOn: [redis]",
    ].join("\n"),
  );

  return fixtureDir;
}

async function createStatusFixture(projectName) {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-status-"));
  await writeFile(
    path.join(fixtureDir, ".devrc.yml"),
    [
      `project: ${projectName}`,
      "groups:",
      "  infra:",
      "    services: [redis]",
      "  api:",
      "    services: [api]",
      "services:",
      "  redis:",
      "    cwd: .",
      "    command: redis-server",
      "    group: infra",
      "  api:",
      "    cwd: .",
      "    command: node server.js",
      "    group: api",
    ].join("\n"),
  );

  return fixtureDir;
}

async function configureGitIdentity(cwd) {
  await runGit(cwd, ["config", "user.email", "dev-cli@example.com"]);
  await runGit(cwd, ["config", "user.name", "Dev CLI"]);
}

async function createGitPullFixture(projectName) {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dev-cli-git-pull-"));
  const remoteDir = path.join(fixtureDir, "remote.git");
  const seedDir = path.join(fixtureDir, "seed");
  const serviceDir = path.join(fixtureDir, "service");
  const upstreamDir = path.join(fixtureDir, "upstream");

  await runGit(fixtureDir, ["init", "--bare", "--initial-branch=main", remoteDir]);
  await runGit(fixtureDir, ["clone", remoteDir, seedDir]);
  await configureGitIdentity(seedDir);
  await writeFile(path.join(seedDir, "README.md"), "initial\n");
  await runGit(seedDir, ["add", "README.md"]);
  await runGit(seedDir, ["commit", "-m", "initial"]);
  await runGit(seedDir, ["push", "origin", "HEAD"]);

  await runGit(fixtureDir, ["clone", remoteDir, serviceDir]);
  await runGit(fixtureDir, ["clone", remoteDir, upstreamDir]);
  await configureGitIdentity(serviceDir);
  await configureGitIdentity(upstreamDir);
  await runGit(serviceDir, ["checkout", "-b", "feature/test"]);
  await runGit(serviceDir, ["push", "-u", "origin", "feature/test"]);
  await runGit(upstreamDir, ["fetch", "origin"]);
  await runGit(upstreamDir, ["checkout", "-b", "feature/test", "origin/feature/test"]);

  await writeFile(
    path.join(serviceDir, "service.js"),
    [
      "console.log('boot');",
      "process.on('SIGTERM', () => {",
      "  setTimeout(() => process.exit(0), 250);",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );

  await writeFile(path.join(upstreamDir, "README.md"), "initial\nupstream\n");
  await runGit(upstreamDir, ["add", "README.md"]);
  await runGit(upstreamDir, ["commit", "-m", "upstream"]);
  await runGit(upstreamDir, ["push", "origin", "HEAD"]);

  const branch = (await runGit(serviceDir, ["branch", "--show-current"])).stdout.trim();

  await writeFile(
    path.join(fixtureDir, ".devrc.yml"),
    [
      `project: ${projectName}`,
      "groups:",
      "  api:",
      "    services: [api]",
      "services:",
      "  api:",
      "    cwd: ./service",
      "    command: node ./service.js",
      "    group: api",
    ].join("\n"),
  );

  return { branch, fixtureDir, serviceDir };
}

test("buildShortcutLine shows restart and clear logs only when available", async () => {
  const {
    buildHeaderContent,
    buildShortcutLine,
    computeCpuPercent,
    formatResourceMetrics,
    getSupervisorPaneLayout,
    parseDarwinMemoryUsage,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const runningSelected = {
    branch: "main",
    command: "node server.js",
    cwd: "/tmp",
    exitCode: null,
    group: "api",
    installCommand: "yarn",
    isGit: true,
    lastStartedAt: null,
    lastStoppedAt: null,
    logPath: "/tmp/api.log",
    pid: 123,
    service: "api",
    status: "running",
  };

  const stoppedSelected = {
    ...runningSelected,
    pid: null,
    status: "stopped",
  };

  assert.match(buildShortcutLine(runningSelected, true), /\[r\] Restart/);
  assert.match(buildShortcutLine(runningSelected, true), /\[c\] Clear logs/);
  assert.match(buildShortcutLine(runningSelected, true), /\[t\] Terminal/);
  assert.doesNotMatch(buildShortcutLine(runningSelected, true), /\[p\] Pull/);
  assert.doesNotMatch(buildShortcutLine(runningSelected, true), /\[d\] Branch/);
  assert.doesNotMatch(buildShortcutLine(runningSelected, false), /\[c\] Clear logs/);
  assert.doesNotMatch(buildShortcutLine(null, false), /\[t\] Terminal/);
  assert.doesNotMatch(buildShortcutLine(stoppedSelected, true), /\[r\] Restart/);
  assert.match(buildShortcutLine(stoppedSelected, true), /\[p\] Pull/);
  assert.match(buildShortcutLine(stoppedSelected, true), /\[d\] Branch/);

  const layout = getSupervisorPaneLayout(100);
  assert.equal(layout.servicesWidth, 44);
  assert.equal(layout.logLeft, 44);
  assert.equal(layout.logWidth, 56);

  assert.equal(
    formatResourceMetrics({
      cpuPercent: 23,
      ramTotalBytes: 10.8 * 1024 ** 3,
      ramUsedBytes: 5.2 * 1024 ** 3,
    }),
    "CPU 23%  RAM 5.2GB/10.8GB",
  );
  assert.equal(
    formatResourceMetrics({
      cpuPercent: null,
      ramTotalBytes: null,
      ramUsedBytes: null,
    }),
    "CPU --  RAM --",
  );
  assert.equal(
    computeCpuPercent(
      { idle: 100, total: 200 },
      { idle: 120, total: 300 },
    ),
    80,
  );
  assert.deepEqual(
    parseDarwinMemoryUsage(
      [
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
        "Pages free:                              277736.",
        "Pages active:                            188968.",
        "Pages inactive:                          202966.",
        "Pages speculative:                         3380.",
        "Pages wired down:                        143412.",
        "Pages occupied by compressor:            194470.",
      ].join("\n"),
      10.8 * 1024 ** 3,
    ),
    {
      ramTotalBytes: 10.8 * 1024 ** 3,
      ramUsedBytes: (188968 + 143412 + 194470) * 16384,
    },
  );
  const headerContent = buildHeaderContent(
    "amigo",
    "Running 1/2 services",
    "CPU 23%  RAM 5.2GB/10.8GB",
    48,
  );
  assert.match(headerContent, /^\s+\{bold\}amigo\{\/bold\}\n\s{2}Running 1\/2 services/u);
  assert.match(headerContent, /CPU 23%/u);
  assert.match(headerContent, /RAM 5\.2GB/u);
  assert.match(headerContent, /…\s{2}$/u);
});

test("buildTerminalLaunchCommands prioritizes the current terminal and service cwd", async () => {
  const { buildTerminalLaunchCommands } = await import(path.join(projectRoot, "dist/lib.js"));
  const cwd = "/tmp/my service/quote'path";

  const tmuxSession = buildTerminalLaunchCommands(cwd, {
    env: { TMUX: "/tmp/tmux-501/default,123,0" },
    platform: "darwin",
    windowTitle: "api",
  });
  assert.equal(tmuxSession[0].label, "tmux");
  assert.equal(tmuxSession[0].command, "tmux");
  assert.deepEqual(tmuxSession[0].args, ["new-window", "-c", cwd, "-n", "api"]);
  assert.equal(tmuxSession[0].cwd, cwd);

  const alacrittyDarwin = buildTerminalLaunchCommands(cwd, {
    env: { __CFBundleIdentifier: "org.alacritty" },
    platform: "darwin",
  });
  assert.equal(alacrittyDarwin[0].label, "Alacritty");
  assert.equal(alacrittyDarwin[0].command, "open");
  assert.deepEqual(alacrittyDarwin[0].args, ["-na", "Alacritty", "--args", "--working-directory", cwd]);
  assert.equal(alacrittyDarwin[0].cwd, cwd);

  const itermDarwin = buildTerminalLaunchCommands(cwd, {
    env: { TERM_PROGRAM: "iTerm.app" },
    platform: "darwin",
  });
  assert.equal(itermDarwin[0].label, "iTerm");
  assert.equal(itermDarwin[0].command, "osascript");
  assert.match(itermDarwin[0].args[1], /create window with default profile/);
  assert.ok(itermDarwin[0].args[1].includes(`write text "cd '/tmp/my service/quote'\\\\''path'"`));

  const terminalFallback = buildTerminalLaunchCommands(cwd, {
    env: {},
    platform: "darwin",
  });
  assert.equal(terminalFallback[0].label, "Terminal");
  assert.match(terminalFallback[0].args[1], /tell application "Terminal"/);

  const linuxKitty = buildTerminalLaunchCommands(cwd, {
    env: { TERM: "xterm-kitty" },
    platform: "linux",
  });
  assert.equal(linuxKitty[0].label, "Kitty");
  assert.deepEqual(linuxKitty[0].args, ["--directory", cwd]);

  const linuxFallback = buildTerminalLaunchCommands(cwd, {
    env: {},
    platform: "linux",
  });
  assert.equal(linuxFallback[0].command, "x-terminal-emulator");
  assert.equal(linuxFallback[0].cwd, cwd);

  const windowsTerminal = buildTerminalLaunchCommands("C:\\Users\\Dev User\\api", {
    env: { WT_SESSION: "1" },
    platform: "win32",
  });
  assert.equal(windowsTerminal[0].label, "Windows Terminal");
  assert.deepEqual(windowsTerminal[0].args, ["-w", "new", "-d", "C:\\Users\\Dev User\\api"]);
});

test("buildLogViewerCommand uses the native terminal viewer script", async () => {
  const { buildLogViewerCommand } = await import(path.join(projectRoot, "dist/lib.js"));
  const command = buildLogViewerCommand("/tmp/api.log");

  assert.equal(command.command, process.execPath);
  assert.equal(command.args[0], "--eval");
  assert.equal(command.args[2], "/tmp/api.log");
  assert.match(command.args[1], /press v to return/);
  assert.match(command.args[1], /input\[i\] === "v"/);
  assert.match(command.args[1], /\\x1b\[A/);
  assert.match(command.args[1], /\\x1b\[B/);
  assert.match(command.args[1], /\\x1b\[\?1049h/);
  assert.match(command.args[1], /\\x1b\[\?1007h/);
  assert.match(command.args[1], /clearVisibleScreenPreservingScrollback/);
  assert.match(command.args[1], /"\\n"\.repeat\(terminalRows\(\)\)/);
  assert.match(command.args[1], /stdout\.write\(content\)/);
  assert.match(command.args[1], /pagerMode/);
  assert.doesNotMatch(command.args[1], /\\x1b\[\?1000h/);
  assert.doesNotMatch(command.args[1], /\\x1b\[\?1006h/);
  assert.doesNotMatch(command.args[1], /\\x1b\[3J/);
});

test("launchExternalLogViewer suspends and restores the screen around the viewer process", async () => {
  const { launchExternalLogViewer } = await import(path.join(projectRoot, "dist/lib.js"));
  const events = [];

  const screen = {
    alloc: () => {
      events.push("alloc");
    },
    enter: () => {
      events.push("enter");
    },
    leave: () => {
      events.push("leave");
    },
    program: {
      disableMouse: () => {
        events.push("disableMouse");
      },
      enableMouse: () => {
        events.push("enableMouse");
      },
      input: {
        pause: () => {
          events.push("input.pause");
        },
        resume: () => {
          events.push("input.resume");
        },
        setRawMode: (mode) => {
          events.push(`input.raw:${mode}`);
        },
      },
    },
    render: () => {
      events.push("render");
    },
  };

  const focusTarget = {
    focus: () => {
      events.push("focus");
    },
  };

  const result = launchExternalLogViewer(
    screen,
    {
      command: "bash",
      args: ["-c", "cat \"$1\"; read -rn 1 -s _", "--", "/tmp/api.log"],
    },
    focusTarget,
    (command, args, options) => {
      assert.equal(command, "bash");
      assert.deepEqual(args, ["-c", "cat \"$1\"; read -rn 1 -s _", "--", "/tmp/api.log"]);
      assert.deepEqual(options, { stdio: "inherit" });
      events.push("spawn");
      return { status: 0 };
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(events, [
    "input.raw:false",
    "input.pause",
    "leave",
    "disableMouse",
    "spawn",
    "input.raw:true",
    "input.resume",
    "enter",
    "enableMouse",
    "focus",
    "render",
  ]);
});

test("status prints config services when supervisor is not running", async () => {
  const projectName = `dev-cli-status-idle-${Date.now()}`;
  const fixtureDir = await createStatusFixture(projectName);

  const result = await execa("node", [cliEntry, "status", projectName], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      TEMP: "/tmp",
      TMP: "/tmp",
      TMPDIR: "/tmp",
    },
  });
  const stdout = stripAnsi(result.stdout);

  assert.equal(result.exitCode, 0);
  assert.match(stdout, /\bSERVICE\b/);
  assert.match(stdout, /\bGROUP\b/);
  assert.match(stdout, /\bSTATUS\b/);
  assert.match(stdout, /\bBRANCH\b/);
  assert.match(stdout, /\bredis\b/);
  assert.match(stdout, /\bapi\b/);
  assert.match(stdout, /\bstopped\b/);
  assert.match(stdout, /│\s*-\s*│/u);
});

test("status prints live supervisor state when running", async () => {
  const projectName = `dev-cli-status-live-${Date.now()}`;
  const fixtureDir = await createSupervisorFixture(projectName);
  const {
    clearSupervisorFiles,
    loadProjectConfig,
    readSupervisorState,
    saveSupervisorState,
    sendSupervisorRequest,
    SupervisorDaemon,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      await stat(state.socketPath);
    });

    const startResponse = await sendSupervisorRequest(projectName, {
      id: `start-${Date.now()}`,
      targets: ["api"],
      type: "start",
    });
    assert.equal(startResponse.ok, true);

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.equal(state?.services.api.status, "running");
    });

    const state = await readSupervisorState(projectName);
    assert.ok(state);
    state.services.api.isGit = true;
    state.services.api.branch = "feature/status";
    await saveSupervisorState(state);

    const result = await execa("node", [cliEntry, "status", projectName], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        TEMP: "/tmp",
        TMP: "/tmp",
        TMPDIR: "/tmp",
      },
    });
    const stdout = stripAnsi(result.stdout);

    assert.equal(result.exitCode, 0);
    assert.match(stdout, /\brunning\b/);
    assert.match(stdout, /feature\/status/);
    assert.match(stdout, /\bapi\b/);
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(projectName);
  }
});

test("up --no-ui does not print the startup results table", async () => {
  const projectName = `dev-cli-up-no-table-${Date.now()}`;
  const fixtureDir = await createSupervisorFixture(projectName);

  try {
    const upResult = await execa("node", [cliEntry, "up", projectName, "--no-ui"], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        TEMP: "/tmp",
        TMP: "/tmp",
        TMPDIR: "/tmp",
      },
    });
    const stdout = stripAnsi(upResult.stdout);

    assert.equal(upResult.exitCode, 0);
    assert.match(stdout, /Supervisor ".*" is running\./);
    assert.doesNotMatch(stdout, /\bRESULT\b/);
    assert.doesNotMatch(stdout, /\bStarted\b/);
  } finally {
    await execa("node", [cliEntry, "down", projectName], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        TEMP: "/tmp",
        TMP: "/tmp",
        TMPDIR: "/tmp",
      },
      reject: false,
    });
  }
});

test("supervisor up waits before starting services with dependencies", async () => {
  const projectName = `dev-cli-up-deps-${Date.now()}`;
  const fixtureDir = await createSupervisorDependencyFixture(projectName);
  const {
    clearSupervisorFiles,
    DEPENDENCY_START_DELAY_MS,
    loadProjectConfig,
    readSupervisorState,
    sendSupervisorRequest,
    SupervisorDaemon,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      await stat(state.socketPath);
    });

    const startedAt = Date.now();
    const upResponse = await sendSupervisorRequest(projectName, {
      id: `up-${Date.now()}`,
      targets: ["api"],
      type: "up",
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(upResponse.ok, true);
    assert.ok(
      elapsedMs >= DEPENDENCY_START_DELAY_MS - 250,
      `expected dependency startup delay, got ${elapsedMs}ms`,
    );

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.equal(state?.services.redis.status, "running");
      assert.equal(state?.services.api.status, "running");
    });
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(config.project);
  }
});

test("supervisor up applies one shared delay per dependency phase", async () => {
  const projectName = `dev-cli-up-parallel-deps-${Date.now()}`;
  const fixtureDir = await createSupervisorParallelDependencyFixture(projectName);
  const {
    clearSupervisorFiles,
    DEPENDENCY_START_DELAY_MS,
    loadProjectConfig,
    readSupervisorState,
    sendSupervisorRequest,
    SupervisorDaemon,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      await stat(state.socketPath);
    });

    const startedAt = Date.now();
    const upResponse = await sendSupervisorRequest(projectName, {
      id: `up-${Date.now()}`,
      targets: ["api", "worker"],
      type: "up",
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(upResponse.ok, true);
    assert.ok(
      elapsedMs >= DEPENDENCY_START_DELAY_MS - 250,
      `expected shared dependency delay, got ${elapsedMs}ms`,
    );
    assert.ok(
      elapsedMs < DEPENDENCY_START_DELAY_MS * 2 - 1_000,
      `expected one phase delay instead of one delay per service, got ${elapsedMs}ms`,
    );

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.equal(state?.services.redis.status, "running");
      assert.equal(state?.services.api.status, "running");
      assert.equal(state?.services.worker.status, "running");
    });
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(config.project);
  }
});

test("triggerUpSupervisor returns immediately while dependency startup continues in background", async () => {
  const projectName = `dev-cli-up-trigger-${Date.now()}`;
  const fixtureDir = await createSupervisorDependencyFixture(projectName);
  const {
    clearSupervisorFiles,
    DEPENDENCY_START_DELAY_MS,
    loadProjectConfig,
    readSupervisorState,
    SupervisorDaemon,
    triggerUpSupervisor,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      await stat(state.socketPath);
    });

    const startedAt = Date.now();
    await triggerUpSupervisor(config, ["api"]);
    const elapsedMs = Date.now() - startedAt;

    assert.ok(
      elapsedMs < DEPENDENCY_START_DELAY_MS - 1_000,
      `expected triggerUpSupervisor to return before dependency delay, got ${elapsedMs}ms`,
    );

    const stateDuringStartup = await Promise.race([
      readSupervisorState(projectName),
      sleep(1_000).then(() => {
        throw new Error("Timed out waiting for state during async up.");
      }),
    ]);

    assert.ok(stateDuringStartup);

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.equal(state?.services.redis.status, "running");
      assert.equal(state?.services.api.status, "running");
    });
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(config.project);
  }
});

test("supervisor restart stops and starts the service again", async () => {
  const projectName = `dev-cli-restart-${Date.now()}`;
  const fixtureDir = await createSupervisorFixture(projectName);
  const {
    clearSupervisorFiles,
    loadProjectConfig,
    readSupervisorState,
    sendSupervisorRequest,
    SupervisorDaemon,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      await stat(state.socketPath);
    });

    const startResponse = await sendSupervisorRequest(projectName, {
      id: `start-${Date.now()}`,
      targets: ["api"],
      type: "start",
    });
    assert.equal(startResponse.ok, true);

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.equal(state?.services.api.status, "running");
      assert.ok(state?.services.api.pid);
    });

    const initialState = await readSupervisorState(projectName);
    const initialPid = initialState?.services.api.pid;

    const restartResponse = await sendSupervisorRequest(projectName, {
      id: `restart-${Date.now()}`,
      targets: ["api"],
      type: "restart",
    });

    assert.equal(restartResponse.ok, true);
    assert.equal(restartResponse.results?.[0]?.message, "Restarted");

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.equal(state?.services.api.status, "running");
      assert.ok(state?.services.api.pid);
      assert.notEqual(state?.services.api.pid, initialPid);
    });
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(projectName);
  }
});

test("supervisor clear-logs truncates the selected service log", async () => {
  const projectName = `dev-cli-clear-logs-${Date.now()}`;
  const fixtureDir = await createSupervisorFixture(projectName);
  const {
    clearSupervisorFiles,
    loadProjectConfig,
    readSupervisorState,
    sendSupervisorRequest,
    SupervisorDaemon,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      await stat(state.socketPath);
    });

    const startResponse = await sendSupervisorRequest(projectName, {
      id: `start-${Date.now()}`,
      targets: ["api"],
      type: "start",
    });
    assert.equal(startResponse.ok, true);

    const serviceState = await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.equal(state?.services.api.status, "running");
      return state.services.api;
    });

    await waitFor(async () => {
      const info = await stat(serviceState.logPath);
      assert.ok(info.size > 0);
    });

    const clearResponse = await sendSupervisorRequest(projectName, {
      id: `clear-logs-${Date.now()}`,
      targets: ["api"],
      type: "clear-logs",
    });
    assert.equal(clearResponse.ok, true);
    assert.equal(clearResponse.results?.[0]?.message, "Logs cleared");

    await waitFor(async () => {
      const info = await stat(serviceState.logPath);
      assert.equal(info.size, 0);
    });
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(projectName);
  }
});

test("supervisor pull-branch rebases the current branch for a stopped git service", async () => {
  const projectName = `dev-cli-pull-${Date.now()}`;
  const { branch, fixtureDir, serviceDir } = await createGitPullFixture(projectName);
  const {
    clearSupervisorFiles,
    loadProjectConfig,
    readSupervisorState,
    sendSupervisorRequest,
    SupervisorDaemon,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      assert.equal(state.services.api.isGit, true);
      await stat(state.socketPath);
    });

    const beforeHead = (await runGit(serviceDir, ["rev-parse", "HEAD"])).stdout.trim();
    const pullResponse = await sendSupervisorRequest(projectName, {
      id: `pull-${Date.now()}`,
      service: "api",
      type: "pull-branch",
    });

    assert.equal(pullResponse.ok, true);
    assert.equal(pullResponse.results?.[0]?.message, `Pulled ${branch} with rebase.`);

    const afterHead = (await runGit(serviceDir, ["rev-parse", "HEAD"])).stdout.trim();
    assert.notEqual(afterHead, beforeHead);

    const state = await readSupervisorState(projectName);
    assert.equal(state?.services.api.status, "stopped");
    assert.equal(state?.services.api.branch, branch);
    const logContent = await readFile(state.services.api.logPath, "utf8");
    assert.match(logContent, /\[dev-cli\] Running git pull --rebase\.\.\./);
    assert.match(logContent, new RegExp(`\\[dev-cli\\] Pulled ${branch} with rebase\\.`));
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(projectName);
  }
});

test("supervisor checkout-branch writes git action results to the service log", async () => {
  const projectName = `dev-cli-checkout-log-${Date.now()}`;
  const { fixtureDir } = await createGitPullFixture(projectName);
  const {
    clearSupervisorFiles,
    loadProjectConfig,
    readSupervisorState,
    sendSupervisorRequest,
    SupervisorDaemon,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      assert.equal(state.services.api.isGit, true);
      await stat(state.socketPath);
    });

    const checkoutResponse = await sendSupervisorRequest(projectName, {
      branch: "main",
      id: `checkout-${Date.now()}`,
      service: "api",
      type: "checkout-branch",
    });

    assert.equal(checkoutResponse.ok, true);
    assert.equal(checkoutResponse.results?.[0]?.message, "Checked out main.");

    const state = await readSupervisorState(projectName);
    const logContent = await readFile(state.services.api.logPath, "utf8");
    assert.match(logContent, /\[dev-cli\] Running git checkout main\.\.\./);
    assert.match(logContent, /\[dev-cli\] Checked out main\./);
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(projectName);
  }
});

test("supervisor checkout-branch fails while the service is running", async () => {
  const projectName = `dev-cli-checkout-running-${Date.now()}`;
  const { fixtureDir } = await createGitPullFixture(projectName);
  const {
    clearSupervisorFiles,
    loadProjectConfig,
    readSupervisorState,
    sendSupervisorRequest,
    SupervisorDaemon,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      await stat(state.socketPath);
    });

    const startResponse = await sendSupervisorRequest(projectName, {
      id: `start-${Date.now()}`,
      targets: ["api"],
      type: "start",
    });
    assert.equal(startResponse.ok, true);

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.equal(state?.services.api.status, "running");
    });

    const checkoutResponse = await sendSupervisorRequest(projectName, {
      branch: "main",
      id: `checkout-${Date.now()}`,
      service: "api",
      type: "checkout-branch",
    });

    assert.equal(checkoutResponse.ok, false);
    assert.equal(checkoutResponse.results?.[0]?.message, "api cannot switch branch from status running.");
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(projectName);
  }
});

test("supervisor pull-branch fails while the service is running", async () => {
  const projectName = `dev-cli-pull-running-${Date.now()}`;
  const { fixtureDir } = await createGitPullFixture(projectName);
  const {
    clearSupervisorFiles,
    loadProjectConfig,
    readSupervisorState,
    sendSupervisorRequest,
    SupervisorDaemon,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      await stat(state.socketPath);
    });

    const startResponse = await sendSupervisorRequest(projectName, {
      id: `start-${Date.now()}`,
      targets: ["api"],
      type: "start",
    });
    assert.equal(startResponse.ok, true);

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.equal(state?.services.api.status, "running");
    });

    const pullResponse = await sendSupervisorRequest(projectName, {
      id: `pull-${Date.now()}`,
      service: "api",
      type: "pull-branch",
    });

    assert.equal(pullResponse.ok, false);
    assert.equal(pullResponse.results?.[0]?.message, "api cannot pull from status running.");
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(projectName);
  }
});

test("supervisor pull-branch fails for a non-git service", async () => {
  const projectName = `dev-cli-pull-no-git-${Date.now()}`;
  const fixtureDir = await createSupervisorFixture(projectName);
  const {
    clearSupervisorFiles,
    loadProjectConfig,
    readSupervisorState,
    sendSupervisorRequest,
    SupervisorDaemon,
  } = await import(path.join(projectRoot, "dist/lib.js"));

  const config = await loadProjectConfig(projectName, fixtureDir);
  const daemon = await SupervisorDaemon.create(projectName, fixtureDir);

  try {
    await daemon.start();

    await waitFor(async () => {
      const state = await readSupervisorState(projectName);
      assert.ok(state);
      await stat(state.socketPath);
    });

    const pullResponse = await sendSupervisorRequest(projectName, {
      id: `pull-${Date.now()}`,
      service: "api",
      type: "pull-branch",
    });

    assert.equal(pullResponse.ok, false);
    assert.equal(pullResponse.results?.[0]?.message, "api is not a git repository.");
  } finally {
    await daemon.shutdown().catch(() => {});
    await clearSupervisorFiles(projectName);
  }
});
