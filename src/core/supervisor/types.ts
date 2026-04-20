export type ManagedServiceStatus =
  | "running"
  | "starting"
  | "restarting"
  | "installing"
  | "stopped"
  | "stopping"
  | "failed";

export type SupervisorRequestType =
  | "up"
  | "up-background"
  | "start"
  | "stop"
  | "restart"
  | "install"
  | "clear-logs"
  | "checkout-branch"
  | "pull-branch"
  | "shutdown"
  | "ping";

export interface ManagedServiceState {
  branch: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  group: string;
  installCommand?: string;
  isGit: boolean;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  logPath: string;
  pid: number | null;
  service: string;
  status: ManagedServiceStatus;
}

export interface SupervisorState {
  configPath: string;
  groups: Record<string, string[]>;
  pid: number;
  project: string;
  rootDir: string;
  services: Record<string, ManagedServiceState>;
  socketPath: string;
  startedAt: string;
  updatedAt: string;
}

export interface SupervisorRequest {
  branch?: string;
  id: string;
  service?: string;
  targets?: string[];
  type: SupervisorRequestType;
}

export interface SupervisorServiceResult {
  message: string;
  ok: boolean;
  service: string;
}

export interface SupervisorResponse {
  id: string;
  message?: string;
  ok: boolean;
  results?: SupervisorServiceResult[];
}
