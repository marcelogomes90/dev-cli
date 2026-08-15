export type HookName = "beforeUp" | "afterUp" | "beforeDown";

export interface GroupConfig {
  services: string[];
  layout?: string;
}

export interface HooksConfig {
  beforeUp?: string[];
  afterUp?: string[];
  beforeDown?: string[];
}

export interface ServiceConfig {
  name: string;
  /** Display name shown in the UI. Falls back to the service key. */
  title: string;
  cwd: string;
  command: string;
  installCommand?: string;
  group: string;
  autostart: boolean;
  env: Record<string, string>;
  dependsOn: string[];
  ports: number[];
}

export interface ProjectConfig {
  project: string;
  session: string;
  rootDir: string;
  configPath: string;
  groups: Record<string, GroupConfig>;
  hooks: HooksConfig;
  services: Record<string, ServiceConfig>;
  editor?: string;
}
