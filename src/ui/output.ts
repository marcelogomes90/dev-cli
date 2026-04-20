import pc from "picocolors";
import Table from "cli-table3";
import type { ProjectConfig } from "../core/config";
import type { SupervisorState } from "../core/supervisor";

export const STATUS_TABLE_HEAD = ["SERVICE", "GROUP", "STATUS", "BRANCH"];

export function printInfo(message: string): void {
  console.log(pc.cyan(message));
}

export function printSuccess(message: string): void {
  console.log(pc.green(message));
}

export function printWarning(message: string): void {
  console.log(pc.yellow(message));
}

export function printError(message: string): void {
  console.error(pc.red(message));
}

export function renderTable(head: string[], rows: string[][]): void {
  const table = new Table({ head });
  for (const row of rows) {
    table.push(row);
  }
  console.log(table.toString());
}

export function buildStatusRowsFromConfig(config: ProjectConfig): string[][] {
  const rows: string[][] = [];

  for (const [groupName, group] of Object.entries(config.groups)) {
    for (const serviceName of group.services) {
      rows.push([serviceName, groupName, "stopped", "-"]);
    }
  }

  return rows;
}

export function buildStatusRowsFromState(state: SupervisorState): string[][] {
  const rows: string[][] = [];

  for (const [groupName, serviceNames] of Object.entries(state.groups)) {
    for (const serviceName of serviceNames) {
      const service = state.services[serviceName];
      if (!service) {
        continue;
      }

      rows.push([
        service.service,
        groupName,
        service.status,
        service.isGit ? service.branch : "-",
      ]);
    }
  }

  return rows;
}
