import path from "node:path";
import type { ProjectConfig } from "../config";
import { getSupervisorPaths } from "./paths";
import type { ManagedServiceState } from "./types";

/** State written before `ports` existed has none, so a running supervisor keeps rendering. */
export function getServicePorts(service: Pick<ManagedServiceState, "ports">): number[] {
  return service.ports ?? [];
}

/**
 * Every user-facing surface shows the configured title; the service key stays the identifier
 * used by requests, logs and state lookups. State written before `title` existed falls back
 * to the key so an already running supervisor keeps rendering.
 */
export function getServiceLabel(service: Pick<ManagedServiceState, "service" | "title">): string {
  return service.title || service.service;
}

export function createServiceState(
  project: string,
  group: string,
  service: ProjectConfig["services"][string],
): ManagedServiceState {
  const paths = getSupervisorPaths(project);

  return {
    branch: "-",
    command: service.command,
    cwd: service.cwd,
    exitCode: null,
    group,
    installCommand: service.installCommand,
    isGit: false,
    lastStartedAt: null,
    lastStoppedAt: null,
    logPath: path.join(paths.logsDir, `${service.name}.log`),
    memoryBytes: null,
    pid: null,
    cpuPercent: null,
    ports: service.ports,
    service: service.name,
    status: "stopped",
    title: service.title,
  };
}
