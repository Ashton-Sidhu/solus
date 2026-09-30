import type { Message } from "@solus/contracts/types";
import { z } from "zod";

const SHELL_WRAPPED = /^(?:\/\S+\/)?(?:sh|bash|zsh)\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*c[A-Za-z]*\s+(?:'([^']*)'|"([^"]*)"|(.+))$/;

/** The command inside a login-shell wrapper — Codex records
 *  `/bin/zsh -lc 'bun test'` — or the command itself when it has none. */
export function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const shellWrapped = trimmed.match(SHELL_WRAPPED);
  return shellWrapped ? unwrapShellCommand(shellWrapped[1] ?? shellWrapped[2] ?? shellWrapped[3] ?? "") : trimmed;
}

export function isGitCommand(command: string | undefined): boolean {
  if (!command?.trim()) return false;
  return /(?:^|[;&|]\s*|&&\s*|\|\|\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:\S+\/)?git(?:\s|$)/.test(unwrapShellCommand(command));
}

/** A path under the project, as the reader knows it: relative to the project. */
export function projectRelativePath(path: string, projectPath?: string | null): string {
  const prefix = projectPath ? projectPath.replace(/\/$/, "") + "/" : "";
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function addStringPath(paths: Set<string>, value: string | undefined, projectPath?: string): void {
  if (!value?.trim()) return;
  paths.add(projectRelativePath(value.trim(), projectPath));
}

const changedPathSchema = z.object({
  path: z.string().optional(),
  filePath: z.string().optional(),
  file_path: z.string().optional(),
  filename: z.string().optional(),
  file: z.string().optional(),
});

const changedFileToolInputSchema = changedPathSchema.extend({
  changes: z.array(changedPathSchema).optional(),
});

type ChangedPath = z.infer<typeof changedPathSchema>;
type ChangedFileToolInput = z.infer<typeof changedFileToolInputSchema>;

function addPathsFromChange(paths: Set<string>, change: ChangedPath, projectPath?: string): void {
  addStringPath(paths, change.path, projectPath);
  addStringPath(paths, change.filePath, projectPath);
  addStringPath(paths, change.file_path, projectPath);
  addStringPath(paths, change.filename, projectPath);
  addStringPath(paths, change.file, projectPath);
}

function addPathsFromParsed(paths: Set<string>, parsed: ChangedFileToolInput, projectPath?: string): void {
  addPathsFromChange(paths, parsed, projectPath);
  for (const change of parsed.changes ?? []) addPathsFromChange(paths, change, projectPath);
}

function addPathsFromText(paths: Set<string>, input: string, projectPath?: string): void {
  for (const match of input.matchAll(/"file_path"\s*:\s*"([^"]+)"/g)) {
    addStringPath(paths, match[1], projectPath);
  }
  for (const match of input.matchAll(/"filePath"\s*:\s*"([^"]+)"/g)) {
    addStringPath(paths, match[1], projectPath);
  }
  for (const match of input.matchAll(/"path"\s*:\s*"([^"]+)"/g)) {
    addStringPath(paths, match[1], projectPath);
  }
  for (const match of input.matchAll(/"filename"\s*:\s*"([^"]+)"/g)) {
    addStringPath(paths, match[1], projectPath);
  }
  for (const match of input.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    addStringPath(paths, match[2] || match[1], projectPath);
  }
}

function collectMessagePaths(paths: Set<string>, m: Message, projectPath?: string): void {
  if (
    m.role !== "tool" ||
    m.toolStatus !== "completed" ||
    (m.toolName !== "Write" && m.toolName !== "Edit" && m.toolName !== "exec_command")
  ) {
    return;
  }

  if (m.toolInput) {
    try {
      const parsed = changedFileToolInputSchema.safeParse(JSON.parse(m.toolInput));
      if (parsed.success) addPathsFromParsed(paths, parsed.data, projectPath);
      else addPathsFromText(paths, m.toolInput, projectPath);
    } catch {
      addPathsFromText(paths, m.toolInput, projectPath);
    }
  }

  if (m.toolName === "exec_command" && m.content && !isGitCommand(m.toolInput)) {
    addPathsFromText(paths, m.content, projectPath);
  }
}

export function extractChangedFilePaths(
  messages: readonly Message[],
  opts: { projectPath?: string } = {},
): string[] {
  const paths = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    collectMessagePaths(paths, messages[i], opts.projectPath);
  }

  return [...paths];
}

/**
 * Extract changed-file paths from a single completed tool message. Used for the
 * incremental changedFiles path so a tool_call_complete doesn't rescan and
 * re-JSON.parse every historical Write/Edit body (O(session²)).
 */
export function extractChangedFilePathsFromMessage(
  message: Message,
  opts: { projectPath?: string } = {},
): string[] {
  const paths = new Set<string>();
  collectMessagePaths(paths, message, opts.projectPath);
  return [...paths];
}

export function toAbsoluteFilePaths(filePaths: readonly string[], cwd?: string): string[] {
  const root = cwd?.replace(/\/$/, "");
  return filePaths.map((path) => {
    if (!root || path.startsWith("/") || path.startsWith("~")) return path;
    return `${root}/${path}`;
  });
}
