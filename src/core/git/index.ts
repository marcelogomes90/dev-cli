import { execa } from "execa";
import { AppError } from "../../utils/errors";

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execa("git", args, {
      cwd,
      reject: true,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new AppError(
      error instanceof Error ? error.message : `Git command failed: ${args.join(" ")}`,
    );
  }
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      reject: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const branch = await runGit(cwd, ["branch", "--show-current"]);
  return branch || "-";
}

function getCheckoutErrorMessage(branch: string, output: string): string {
  const normalized = output.trim();

  if (/local changes.*would be overwritten|please commit your changes/i.test(normalized)) {
    return "Local changes prevent switching branch. Commit or stash them first.";
  }

  if (/not a valid branch name|is not a valid branch name/i.test(normalized)) {
    return `Invalid branch name "${branch}".`;
  }

  if (/already exists/i.test(normalized)) {
    return `Branch "${branch}" already exists locally.`;
  }

  if (normalized) {
    const firstLine = normalized.split("\n").find((line) => line.trim()) ?? normalized;
    return firstLine.trim();
  }

  return `Failed to checkout branch "${branch}".`;
}

function getPullErrorMessage(output: string): string {
  const normalized = output.trim();

  if (/There is no tracking information for the current branch/i.test(normalized)) {
    return "Current branch has no upstream configured.";
  }

  if (/cannot pull with rebase/i.test(normalized) || /please commit or stash/i.test(normalized)) {
    return "Local changes prevent pulling with rebase. Commit or stash them first.";
  }

  if (/CONFLICT/i.test(normalized)) {
    return "Pull with rebase produced conflicts. Resolve them manually.";
  }

  if (normalized) {
    const firstLine = normalized.split("\n").find((line) => line.trim()) ?? normalized;
    return firstLine.trim();
  }

  return "Failed to pull branch with rebase.";
}

function isMissingBranchError(output: string): boolean {
  return /pathspec .* did not match any file\(s\) known to git|not a commit and a branch|unknown revision/i.test(
    output,
  );
}

export async function checkoutBranch(cwd: string, branch: string): Promise<string> {
  const target = branch.trim();
  if (!target) {
    throw new AppError("Branch name is required.");
  }

  const checkout = await execa("git", ["checkout", target], {
    cwd,
    reject: false,
  });

  if (checkout.exitCode === 0) {
    return getCurrentBranch(cwd);
  }

  const checkoutOutput = [checkout.stderr, checkout.stdout].filter(Boolean).join("\n").trim();
  if (!isMissingBranchError(checkoutOutput)) {
    throw new AppError(getCheckoutErrorMessage(target, checkoutOutput));
  }

  const create = await execa("git", ["checkout", "-b", target], {
    cwd,
    reject: false,
  });

  if (create.exitCode === 0) {
    return getCurrentBranch(cwd);
  }

  const createOutput = [create.stderr, create.stdout].filter(Boolean).join("\n").trim();
  throw new AppError(getCheckoutErrorMessage(target, createOutput));
}

export async function pullBranchRebase(cwd: string): Promise<string> {
  const pull = await execa("git", ["pull", "--rebase"], {
    cwd,
    reject: false,
  });

  if (pull.exitCode === 0) {
    return getCurrentBranch(cwd);
  }

  const pullOutput = [pull.stderr, pull.stdout].filter(Boolean).join("\n").trim();
  throw new AppError(getPullErrorMessage(pullOutput));
}
