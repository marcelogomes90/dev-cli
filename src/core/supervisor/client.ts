import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProjectConfig } from "../config";
import { AppError } from "../../utils/errors";
import { isProcessAlive } from "../../utils/process";
import { clearSupervisorFiles } from "./paths";
import { loadSupervisorState } from "./state";
import type {
  SupervisorRequest,
  SupervisorRequestType,
  SupervisorResponse,
  SupervisorState,
} from "./types";

function makeRequest(
  type: SupervisorRequestType,
  options: {
    branch?: string;
    service?: string;
    targets?: string[];
  } = {},
): SupervisorRequest {
  return {
    branch: options.branch,
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    service: options.service,
    targets: options.targets,
    type,
  };
}

function getSupervisorEntry(): string {
  return fileURLToPath(new URL("./supervisor.js", import.meta.url));
}

function isSocketUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = String((error as NodeJS.ErrnoException).code ?? "");
  return code === "ECONNREFUSED" || code === "ENOENT";
}

async function requestSupervisor(
  socketPath: string,
  request: SupervisorRequest,
): Promise<SupervisorResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let raw = "";

    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      raw += chunk;
      if (!raw.includes("\n")) {
        return;
      }

      const line = raw.slice(0, raw.indexOf("\n"));
      socket.end();

      try {
        resolve(JSON.parse(line) as SupervisorResponse);
      } catch (error) {
        reject(error);
      }
    });

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
  });
}

async function pingSupervisor(project: string): Promise<boolean> {
  const state = await loadSupervisorState(project);
  if (!state || !isProcessAlive(state.pid)) {
    return false;
  }

  try {
    const response = await requestSupervisor(state.socketPath, makeRequest("ping"));
    return response.ok;
  } catch (error) {
    if (isSocketUnavailableError(error)) {
      return false;
    }

    throw error;
  }
}

async function waitForSocket(project: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await pingSupervisor(project)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new AppError(`Timed out while waiting for supervisor socket for "${project}".`);
}

async function loadLiveSupervisorState(project: string): Promise<SupervisorState | null> {
  const state = await loadSupervisorState(project);
  if (!state) {
    return null;
  }

  if (!isProcessAlive(state.pid)) {
    await clearSupervisorFiles(project);
    return null;
  }

  try {
    const response = await requestSupervisor(state.socketPath, makeRequest("ping"));
    if (response.ok) {
      return state;
    }
  } catch (error) {
    if (!isSocketUnavailableError(error)) {
      throw error;
    }
  }

  await clearSupervisorFiles(project);
  return null;
}

export async function ensureSupervisor(config: ProjectConfig): Promise<void> {
  const existing = await loadLiveSupervisorState(config.project);
  if (existing) {
    return;
  }

  const child = spawn(process.execPath, [getSupervisorEntry()], {
    detached: true,
    env: {
      ...process.env,
      DEVCLI_CWD: config.rootDir,
      DEVCLI_PROJECT: config.project,
    },
    stdio: "ignore",
  });
  child.unref();

  await waitForSocket(config.project);
}

export async function sendSupervisorRequest(
  project: string,
  request: SupervisorRequest,
): Promise<SupervisorResponse> {
  const state = await loadLiveSupervisorState(project);
  if (!state) {
    throw new AppError(`Supervisor for "${project}" is not running.`);
  }

  try {
    return await requestSupervisor(state.socketPath, request);
  } catch (error) {
    if (isSocketUnavailableError(error)) {
      await clearSupervisorFiles(project);
      throw new AppError(`Supervisor for "${project}" is not running.`);
    }

    throw error;
  }
}

export async function upSupervisor(
  config: ProjectConfig,
  targets?: string[],
): Promise<SupervisorResponse> {
  await ensureSupervisor(config);
  return sendSupervisorRequest(config.project, makeRequest("up", { targets }));
}

export async function triggerUpSupervisor(
  config: ProjectConfig,
  targets?: string[],
): Promise<void> {
  await ensureSupervisor(config);
  const response = await sendSupervisorRequest(config.project, makeRequest("up-background", { targets }));
  if (!response.ok) {
    throw new AppError(response.message ?? `Unable to schedule supervisor startup for "${config.project}".`);
  }
}

export async function controlSupervisor(
  config: ProjectConfig,
  action: "clear-logs" | "install" | "restart" | "start" | "stop",
  targets?: string[],
): Promise<SupervisorResponse> {
  await ensureSupervisor(config);
  return sendSupervisorRequest(config.project, makeRequest(action, { targets }));
}

export async function checkoutSupervisorBranch(
  config: ProjectConfig,
  service: string,
  branch: string,
): Promise<SupervisorResponse> {
  await ensureSupervisor(config);
  return sendSupervisorRequest(
    config.project,
    makeRequest("checkout-branch", {
      branch,
      service,
    }),
  );
}

export async function pullSupervisorBranch(
  config: ProjectConfig,
  service: string,
): Promise<SupervisorResponse> {
  await ensureSupervisor(config);
  return sendSupervisorRequest(
    config.project,
    makeRequest("pull-branch", {
      service,
    }),
  );
}

export async function shutdownSupervisor(config: ProjectConfig): Promise<SupervisorResponse> {
  const state = await loadLiveSupervisorState(config.project);
  if (!state) {
    return {
      id: `${Date.now()}-noop`,
      ok: true,
      message: `Supervisor for "${config.project}" is not running.`,
    };
  }

  return sendSupervisorRequest(config.project, makeRequest("shutdown"));
}

export async function readSupervisorState(project: string): Promise<SupervisorState | null> {
  return loadLiveSupervisorState(project);
}
