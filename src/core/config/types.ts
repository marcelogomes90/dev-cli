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
  cwd: string;
  command: string;
  installCommand?: string;
  group: string;
  autostart: boolean;
  env: Record<string, string>;
  dependsOn: string[];
}

export interface ProjectConfig {
  project: string;
  session: string;
  rootDir: string;
  configPath: string;
  groups: Record<string, GroupConfig>;
  hooks: HooksConfig;
  services: Record<string, ServiceConfig>;
}
