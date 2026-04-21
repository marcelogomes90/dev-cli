import net from "node:net";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { appendFile, rm, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { loadProjectConfig, type ProjectConfig } from "../config";
import { checkoutBranch, getCurrentBranch, isGitRepository, pullBranchRebase } from "../git";
import { AppError, getErrorMessage } from "../../utils/errors";
import {
  isProcessAlive,
  terminateProcessTree,
  waitForProcessExit,
} from "../../utils/process";
import { buildSupervisorPlan, DEPENDENCY_START_DELAY_MS, resolveTargets, type SupervisorPlan } from "./plan";
import { clearSupervisorFiles, ensureSupervisorDirs, getSupervisorPaths } from "./paths";
import { sanitizeLogChunk } from "./log-sanitizer";
import { buildShellSpawn, resolveRuntimeShell } from "./runtime";
import { createServiceState } from "./service-state";
import { loadSupervisorState, saveSupervisorState } from "./state";
import type {
  ManagedServiceState,
  SupervisorRequest,
  SupervisorResponse,
  SupervisorServiceResult,
  SupervisorState,
} from "./types";

interface ManagedChild {
  child: ChildProcessByStdio<null, Readable, Readable>;
  closePromise: Promise<number>;
  service: string;
}

interface ManagedServiceContext {
  entry: ManagedServiceState;
  service: ProjectConfig["services"][string];
  serviceName: string;
}

const BRANCH_REFRESH_INTERVAL_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const DEFAULT_KILL_TIMEOUT_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SupervisorDaemon {
  private readonly children = new Map<string, ManagedChild>();
  private readonly config: ProjectConfig;
  private readonly handleExit = () => {
    void rm(this.paths.socketPath, { force: true });
  };
  private readonly handleSigint = () => {
    void this.shutdown();
  };
  private readonly handleSigterm = () => {
    void this.shutdown();
  };
  private readonly paths;
  private readonly refreshInterval: NodeJS.Timeout;
  private readonly server: net.Server;
  private readonly state: SupervisorState;
  private commandQueue = Promise.resolve();
  private lastBranchRefreshAt = 0;
  private shuttingDown = false;

  private constructor(config: ProjectConfig) {
    this.config = config;
    this.paths = getSupervisorPaths(config.project);

    this.state = {
      configPath: config.configPath,
      groups: Object.fromEntries(
        Object.entries(config.groups).map(([groupName, group]) => [groupName, [...group.services]]),
      ),
      pid: process.pid,
      project: config.project,
      rootDir: config.rootDir,
      services: Object.fromEntries(
        Object.entries(config.services).map(([serviceName, service]) => [
          serviceName,
          createServiceState(config.project, service.group, service),
        ]),
      ),
      socketPath: this.paths.socketPath,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.server = net.createServer((socket) => {
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        raw += chunk;
        if (!raw.includes("\n")) {
          return;
        }

        const line = raw.slice(0, raw.indexOf("\n"));
        raw = raw.slice(raw.indexOf("\n") + 1);
        void this.enqueueRequest(line, socket);
      });
    });

    this.refreshInterval = setInterval(() => {
      void this.refreshDerivedState();
    }, 1_000);
  }

  static async create(project: string, cwd?: string): Promise<SupervisorDaemon> {
    const config = await loadProjectConfig(project, cwd);
    await ensureSupervisorDirs(project);
    return new SupervisorDaemon(config);
  }

  async start(): Promise<void> {
    await rm(this.paths.socketPath, { force: true });
    await saveSupervisorState(this.state);
    await this.refreshDerivedState(true);

    this.server.listen(this.paths.socketPath);
    this.server.on("error", (error) => {
      console.error(`[dev-cli] supervisor socket error: ${getErrorMessage(error)}`);
      process.exitCode = 1;
      void this.shutdown();
    });

    process.on("SIGINT", this.handleSigint);
    process.on("SIGTERM", this.handleSigterm);
    process.on("exit", this.handleExit);
  }

  private async enqueueRequest(raw: string, socket: net.Socket): Promise<void> {
    let request: SupervisorRequest;
    try {
      request = JSON.parse(raw) as SupervisorRequest;
    } catch {
      socket.end(JSON.stringify({ id: "unknown", ok: false, message: "Invalid request" }) + "\n");
      return;
    }

    if (request.type === "ping") {
      socket.end(JSON.stringify({ id: request.id, ok: true, message: "pong" } satisfies SupervisorResponse) + "\n");
      return;
    }

    if (request.type === "up-background") {
      this.commandQueue = this.commandQueue
        .then(async () => {
          await this.startTargets(request.targets);
        })
        .catch((error) => {
          console.error(`[dev-cli] background up failed: ${getErrorMessage(error)}`);
        });
      socket.end(JSON.stringify({ id: request.id, ok: true, message: "Startup scheduled." } satisfies SupervisorResponse) + "\n");
      return;
    }

    this.commandQueue = this.commandQueue
      .then(async () => {
        const response = await this.handleRequest(request);
        socket.end(JSON.stringify(response) + "\n");
      })
      .catch((error) => {
        socket.end(
          JSON.stringify({
            id: request.id,
            ok: false,
            message: getErrorMessage(error),
          } satisfies SupervisorResponse) + "\n",
        );
      });

    await this.commandQueue;
  }

  private async handleRequest(request: SupervisorRequest): Promise<SupervisorResponse> {
    switch (request.type) {
      case "up":
        return {
          id: request.id,
          ok: true,
          results: await this.startTargets(request.targets),
        };
      case "start":
        return {
          id: request.id,
          ok: true,
          results: await this.startTargets(request.targets, false, false),
        };
      case "stop":
        return {
          id: request.id,
          ok: true,
          results: await this.stopTargets(request.targets),
        };
      case "restart":
        return {
          id: request.id,
          ok: true,
          results: await this.restartTargets(request.targets),
        };
      case "install":
        return {
          id: request.id,
          ok: true,
          results: await this.installTargets(request.targets),
        };
      case "clear-logs":
        return {
          id: request.id,
          ok: true,
          results: await this.clearLogsTargets(request.targets),
        };
      case "checkout-branch": {
        const result = await this.checkoutServiceBranch(request.service, request.branch);
        return {
          id: request.id,
          message: result.message,
          ok: result.ok,
          results: [result],
        };
      }
      case "pull-branch": {
        const result = await this.pullServiceBranch(request.service);
        return {
          id: request.id,
          message: result.message,
          ok: result.ok,
          results: [result],
        };
      }
      case "shutdown":
        await this.shutdown();
        return { id: request.id, ok: true, message: "Supervisor stopped." };
      default:
        return { id: request.id, ok: false, message: `Unsupported request type "${request.type}".` };
    }
  }

  private async refreshDerivedState(forceBranchRefresh = false): Promise<void> {
    const shouldRefreshBranches =
      forceBranchRefresh ||
      this.lastBranchRefreshAt === 0 ||
      Date.now() - this.lastBranchRefreshAt >= BRANCH_REFRESH_INTERVAL_MS;
    let dirty = false;

    for (const [serviceName, service] of Object.entries(this.config.services)) {
      const entry = this.state.services[serviceName];
      if (
        (entry.status === "installing" || entry.status === "running" || entry.status === "stopping") &&
        !isProcessAlive(entry.pid)
      ) {
        entry.pid = null;
        entry.status = "stopped";
        entry.lastStoppedAt ??= new Date().toISOString();
        dirty = true;
      }

      if (shouldRefreshBranches) {
        const nextIsGit = await isGitRepository(service.cwd);
        if (entry.isGit !== nextIsGit) {
          entry.isGit = nextIsGit;
          dirty = true;
        }

        const nextBranch = nextIsGit ? await getCurrentBranch(service.cwd).catch(() => "-") : "-";
        if (entry.branch !== nextBranch) {
          entry.branch = nextBranch;
          dirty = true;
        }
      }
    }

    if (shouldRefreshBranches) {
      this.lastBranchRefreshAt = Date.now();
    }

    if (dirty) {
      await saveSupervisorState(this.state);
    }
  }

  private getManagedServiceContext(serviceName: string | undefined): ManagedServiceContext | SupervisorServiceResult {
    const targetService = serviceName?.trim();

    if (!targetService || !this.state.services[targetService]) {
      return {
        service: targetService || "unknown",
        ok: false,
        message: "Unknown service.",
      };
    }

    return {
      entry: this.state.services[targetService],
      service: this.config.services[targetService],
      serviceName: targetService,
    };
  }

  private async ensureGitServiceContext(
    context: ManagedServiceContext,
  ): Promise<ManagedServiceContext | SupervisorServiceResult> {
    const { entry, service, serviceName } = context;
    const isGit = entry.isGit || (await isGitRepository(service.cwd));

    if (isGit) {
      return context;
    }

    entry.isGit = false;
    await saveSupervisorState(this.state);
    await this.appendSupervisorLog(serviceName, `${serviceName} is not a git repository.`);
    return {
      service: serviceName,
      ok: false,
      message: `${serviceName} is not a git repository.`,
    };
  }

  private async runGitServiceAction(
    context: ManagedServiceContext,
    pendingMessage: string,
    action: () => Promise<string>,
    successMessage: (branchName: string) => string,
  ): Promise<SupervisorServiceResult> {
    const { entry, serviceName } = context;

    try {
      await this.appendSupervisorLog(serviceName, pendingMessage);
      const nextBranch = await action();
      entry.isGit = true;
      entry.branch = nextBranch;
      this.lastBranchRefreshAt = Date.now();
      await saveSupervisorState(this.state);

      const message = successMessage(nextBranch);
      await this.appendSupervisorLog(serviceName, message);
      return {
        service: serviceName,
        ok: true,
        message,
      };
    } catch (error) {
      const message = getErrorMessage(error);
      await this.appendSupervisorLog(serviceName, message);
      return {
        service: serviceName,
        ok: false,
        message,
      };
    }
  }

  private async checkoutServiceBranch(
    serviceName: string | undefined,
    branchName: string | undefined,
  ): Promise<SupervisorServiceResult> {
    const targetBranch = branchName?.trim();
    const context = this.getManagedServiceContext(serviceName);
    if ("ok" in context) {
      return context;
    }

    const { entry, serviceName: targetService } = context;
    if (entry.status !== "stopped") {
      await this.appendSupervisorLog(targetService, `${targetService} cannot switch branch from status ${entry.status}.`);
      return {
        service: targetService,
        ok: false,
        message: `${targetService} cannot switch branch from status ${entry.status}.`,
      };
    }

    if (!targetBranch) {
      return {
        service: targetService,
        ok: false,
        message: "Branch name is required.",
      };
    }

    const gitContext = await this.ensureGitServiceContext(context);
    if ("ok" in gitContext) {
      return gitContext;
    }

    return this.runGitServiceAction(
      gitContext,
      `Running git checkout ${targetBranch}...`,
      () => checkoutBranch(gitContext.service.cwd, targetBranch),
      (nextBranch) => `Checked out ${nextBranch}.`,
    );
  }

  private async pullServiceBranch(serviceName: string | undefined): Promise<SupervisorServiceResult> {
    const context = this.getManagedServiceContext(serviceName);
    if ("ok" in context) {
      return context;
    }

    const { entry, serviceName: targetService } = context;
    if (entry.status !== "stopped") {
      await this.appendSupervisorLog(targetService, `${targetService} cannot pull from status ${entry.status}.`);
      return {
        service: targetService,
        ok: false,
        message: `${targetService} cannot pull from status ${entry.status}.`,
      };
    }

    const gitContext = await this.ensureGitServiceContext(context);
    if ("ok" in gitContext) {
      return gitContext;
    }

    return this.runGitServiceAction(
      gitContext,
      "Running git pull --rebase...",
      () => pullBranchRebase(gitContext.service.cwd),
      (nextBranch) => `Pulled ${nextBranch} with rebase.`,
    );
  }

  private async appendSupervisorLog(serviceName: string, message: string): Promise<void> {
    const entry = this.state.services[serviceName];
    if (!entry) {
      return;
    }

    const line = message.trim();
    if (!line) {
      return;
    }

    await appendFile(entry.logPath, `[dev-cli] ${line}\n`);
  }

  private async appendServiceLog(serviceName: string, chunk: string): Promise<void> {
    const sanitized = sanitizeLogChunk(chunk);
    if (!sanitized) {
      return;
    }

    await appendFile(this.state.services[serviceName].logPath, sanitized);
  }

  private async runHooks(commands: string[] | undefined): Promise<void> {
    for (const command of commands ?? []) {
      await this.spawnShell(command, this.config.rootDir).completed;
    }
  }

  private spawnShell(command: string, cwd: string) {
    const spawnConfig = buildShellSpawn(resolveRuntimeShell(), command);
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const completed = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 0));
    });

    return { child, completed };
  }

  private registerChild(
    serviceName: string,
    child: ChildProcessByStdio<null, Readable, Readable>,
  ): ManagedChild {
    const closePromise = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 0));
    });

    const managed = { child, closePromise, service: serviceName };
    this.children.set(serviceName, managed);
    return managed;
  }

  private bindManagedProcessLifecycle(serviceName: string, managed: ManagedChild): void {
    const entry = this.state.services[serviceName];

    const finalize = async (exitCode: number, status: ManagedServiceState["status"]) => {
      if (this.children.get(serviceName) !== managed) {
        return;
      }

      this.children.delete(serviceName);
      entry.pid = null;
      entry.exitCode = exitCode;
      entry.lastStoppedAt = new Date().toISOString();
      entry.status = status;
      await saveSupervisorState(this.state);
    };

    managed.child.once("error", async () => {
      await finalize(1, "failed");
    });

    managed.closePromise
      .then(async (code) => {
        await finalize(code, code === 0 || this.shuttingDown ? "stopped" : "failed");
      })
      .catch(async () => {
        await finalize(1, "failed");
      });
  }

  private spawnManagedProcess(serviceName: string, command: string): ManagedChild {
    const service = this.config.services[serviceName];
    const spawnConfig = buildShellSpawn(resolveRuntimeShell(), command);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...service.env,
      TERM: process.env.TERM ?? "xterm-256color",
    };
    if (!("NO_COLOR" in childEnv) && !("FORCE_COLOR" in childEnv)) {
      childEnv.FORCE_COLOR = "1";
    }
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: service.cwd,
      detached: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const managed = this.registerChild(serviceName, child);
    child.stdout.on("data", (chunk) => {
      void this.appendServiceLog(serviceName, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      void this.appendServiceLog(serviceName, chunk.toString());
    });

    return managed;
  }

  private spawnServiceProcess(serviceName: string): ManagedChild {
    return this.spawnManagedProcess(serviceName, this.config.services[serviceName].command);
  }

  private async startService(serviceName: string): Promise<SupervisorServiceResult> {
    const entry = this.state.services[serviceName];

    if (entry.status === "running" && isProcessAlive(entry.pid)) {
      return { service: serviceName, ok: true, message: "Already running" };
    }

    if (isProcessAlive(entry.pid)) {
      await this.stopService(serviceName);
    }

    entry.status = "starting";
    entry.exitCode = null;
    entry.lastStoppedAt = null;
    await writeFile(entry.logPath, "", { flag: "a" });

    const managed = this.spawnServiceProcess(serviceName);
    entry.pid = managed.child.pid ?? null;
    entry.status = "running";
    entry.lastStartedAt = new Date().toISOString();
    await saveSupervisorState(this.state);
    this.bindManagedProcessLifecycle(serviceName, managed);

    return { service: serviceName, ok: true, message: "Started" };
  }

  private async installService(serviceName: string): Promise<SupervisorServiceResult> {
    const entry = this.state.services[serviceName];
    const installCommand = this.config.services[serviceName].installCommand;

    if (!installCommand) {
      return { service: serviceName, ok: false, message: "No install command configured." };
    }

    if (entry.status === "installing" && isProcessAlive(entry.pid)) {
      return { service: serviceName, ok: true, message: "Already installing" };
    }

    if (isProcessAlive(entry.pid)) {
      return {
        service: serviceName,
        ok: false,
        message: `Cannot install while service is ${entry.status}.`,
      };
    }

    entry.status = "installing";
    entry.exitCode = null;
    entry.lastStoppedAt = null;
    await writeFile(entry.logPath, "");

    const managed = this.spawnManagedProcess(serviceName, installCommand);
    entry.pid = managed.child.pid ?? null;
    entry.lastStartedAt = new Date().toISOString();
    await saveSupervisorState(this.state);
    this.bindManagedProcessLifecycle(serviceName, managed);

    return { service: serviceName, ok: true, message: "Installing dependencies" };
  }

  private async restartService(serviceName: string): Promise<SupervisorServiceResult> {
    const entry = this.state.services[serviceName];
    const pid = entry.pid;

    if (entry.status !== "running" || !pid || !isProcessAlive(pid)) {
      return {
        service: serviceName,
        ok: false,
        message: `Cannot restart while service is ${entry.status}.`,
      };
    }

    entry.status = "restarting";
    await saveSupervisorState(this.state);

    const stopResult = await this.stopService(serviceName);
    if (!stopResult.ok) {
      return {
        service: serviceName,
        ok: false,
        message: stopResult.message,
      };
    }

    entry.status = "restarting";
    await saveSupervisorState(this.state);

    const startResult = await this.startService(serviceName);
    if (!startResult.ok) {
      return {
        service: serviceName,
        ok: false,
        message: startResult.message,
      };
    }

    return {
      service: serviceName,
      ok: true,
      message: "Restarted",
    };
  }

  private async stopService(serviceName: string): Promise<SupervisorServiceResult> {
    const entry = this.state.services[serviceName];
    const pid = entry.pid;

    if (!pid || !isProcessAlive(pid)) {
      this.children.delete(serviceName);
      entry.pid = null;
      entry.status = "stopped";
      entry.lastStoppedAt = new Date().toISOString();
      await writeFile(entry.logPath, "");
      await saveSupervisorState(this.state);
      return { service: serviceName, ok: true, message: "Already stopped" };
    }

    entry.status = "stopping";
    await saveSupervisorState(this.state);

    await terminateProcessTree(pid, "SIGTERM");
    const gracefulExit = await waitForProcessExit(pid, DEFAULT_STOP_TIMEOUT_MS);

    if (!gracefulExit && isProcessAlive(pid)) {
      await terminateProcessTree(pid, "SIGKILL");
      await waitForProcessExit(pid, DEFAULT_KILL_TIMEOUT_MS);
    }

    if (isProcessAlive(pid)) {
      entry.status = "failed";
      entry.exitCode = entry.exitCode ?? 1;
      await saveSupervisorState(this.state);
      return { service: serviceName, ok: false, message: "Failed to stop cleanly" };
    }

    entry.pid = null;
    entry.status = "stopped";
    entry.lastStoppedAt = new Date().toISOString();
    await writeFile(entry.logPath, "");
    await saveSupervisorState(this.state);
    return { service: serviceName, ok: true, message: "Stopped" };
  }

  private async clearServiceLogs(serviceName: string): Promise<SupervisorServiceResult> {
    const entry = this.state.services[serviceName];
    await writeFile(entry.logPath, "");
    return { service: serviceName, ok: true, message: "Logs cleared" };
  }

  private async waitForChildrenToExit(): Promise<void> {
    await Promise.all(
      [...this.children.values()].map(({ child, closePromise }) =>
        Promise.race([
          closePromise.catch(() => 1),
          waitForProcessExit(child.pid ?? null, DEFAULT_KILL_TIMEOUT_MS).then(() => 0),
        ]),
      ),
    );
  }

  private async resolvePlanTargets(
    targets: string[] | undefined,
    includeDependencies: boolean,
  ): Promise<SupervisorPlan> {
    const selectedTargets = targets?.length
      ? targets.flatMap((target) => resolveTargets(this.config, target))
      : resolveTargets(this.config);

    return buildSupervisorPlan(this.config, selectedTargets, includeDependencies);
  }

  private async startTargets(
    targets?: string[],
    runHooks = true,
    includeDependencies = true,
  ): Promise<SupervisorServiceResult[]> {
    if (runHooks) {
      await this.runHooks(this.config.hooks.beforeUp);
    }

    const plan = await this.resolvePlanTargets(targets, includeDependencies);
    const results: SupervisorServiceResult[] = [];

    if (!includeDependencies) {
      for (const serviceName of plan.orderedServices) {
        results.push(await this.startService(serviceName));
      }
    } else {
      for (let phaseIndex = 0; phaseIndex < plan.startupPhases.length; phaseIndex += 1) {
        const phase = plan.startupPhases[phaseIndex];
        if (!phase || phase.length === 0) {
          continue;
        }

        if (phaseIndex > 0) {
          await sleep(DEPENDENCY_START_DELAY_MS);
          results.push(...(await Promise.all(phase.map((serviceName) => this.startService(serviceName)))));
          continue;
        }

        for (const serviceName of phase) {
          results.push(await this.startService(serviceName));
        }
      }
    }

    if (runHooks) {
      await this.runHooks(this.config.hooks.afterUp);
    }

    void this.refreshDerivedState(true);
    return results;
  }

  private async stopTargets(targets?: string[]): Promise<SupervisorServiceResult[]> {
    const { orderedServices } = await this.resolvePlanTargets(targets, false);
    const results: SupervisorServiceResult[] = [];

    for (const serviceName of [...orderedServices].reverse()) {
      results.push(await this.stopService(serviceName));
    }

    await this.refreshDerivedState(true);
    return results;
  }

  private async installTargets(targets?: string[]): Promise<SupervisorServiceResult[]> {
    const { orderedServices } = await this.resolvePlanTargets(targets, false);
    const results: SupervisorServiceResult[] = [];

    for (const serviceName of orderedServices) {
      results.push(await this.installService(serviceName));
    }

    await this.refreshDerivedState(true);
    return results;
  }

  private async restartTargets(targets?: string[]): Promise<SupervisorServiceResult[]> {
    const { orderedServices } = await this.resolvePlanTargets(targets, false);
    const results: SupervisorServiceResult[] = [];

    for (const serviceName of orderedServices) {
      results.push(await this.restartService(serviceName));
    }

    await this.refreshDerivedState(true);
    return results;
  }

  private async clearLogsTargets(targets?: string[]): Promise<SupervisorServiceResult[]> {
    const { orderedServices } = await this.resolvePlanTargets(targets, false);
    const results: SupervisorServiceResult[] = [];

    for (const serviceName of orderedServices) {
      results.push(await this.clearServiceLogs(serviceName));
    }

    return results;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    clearInterval(this.refreshInterval);
    process.off("SIGINT", this.handleSigint);
    process.off("SIGTERM", this.handleSigterm);
    process.off("exit", this.handleExit);

    await this.runHooks(this.config.hooks.beforeDown);
    await Promise.all(
      Object.keys(this.state.services).map((serviceName) => this.stopService(serviceName)),
    );
    await this.waitForChildrenToExit();

    this.server.close();
    await rm(this.paths.socketPath, { force: true });
    await clearSupervisorFiles(this.config.project);
  }
}

export async function runSupervisorFromEnv(): Promise<void> {
  const project = process.env.DEVCLI_PROJECT;
  const cwd = process.env.DEVCLI_CWD;

  if (!project) {
    throw new AppError("DEVCLI_PROJECT is required to run the supervisor.");
  }

  const existing = await loadSupervisorState(project);
  if (existing) {
    if (isProcessAlive(existing.pid)) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(existing.socketPath);
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.end();
            resolve();
          });
        });
        throw new AppError(`Supervisor for "${project}" is already running.`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED") {
          throw error;
        }
      }
    }

    await clearSupervisorFiles(project);
  }

  const supervisor = await SupervisorDaemon.create(project, cwd);
  await supervisor.start();
}
