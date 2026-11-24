import type { Message } from "@solus/contracts/types";
import { z } from "zod";
import { patchFileChunks } from "./pierre-diff/patch-files";
import { hostPathSegments, isAbsoluteHostPath, joinHostPath, normalizeHostPath, relativeHostPath } from "@solus/contracts/host-path";
import { locateSessionFile } from "./session-paths";

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
  return (projectPath && relativeHostPath(projectPath, path)) || path;
}

/** The folders that the changed files of one session are named from. */
export interface ChangedFileRoots {
  /** A path under the project is written from it. */
  projectPath?: string;
  /** With `sessionFolders`: the directory that a file of a session folder is named from. */
  workingDirectory?: string;
  /** The folders the session works in besides its working directory (docs/plans/codebases.md §8). */
  sessionFolders?: readonly { path: string }[];
}

/**
 * A changed path as the reader knows it. A file of a session folder is named
 * as the session names it (`lib/session-paths.ts`): its path from the longest
 * session folder that holds it, with that folder's path from the working
 * directory in front, so two repositories never name one file the same. Each
 * other path is written from the project.
 */
export function changedFilePath(path: string, roots: ChangedFileRoots = {}): string {
  if (roots.workingDirectory && roots.sessionFolders?.length) {
    const file = locateSessionFile(path, roots.workingDirectory, roots.sessionFolders);
    if (file.folder) return file.sessionPath;
  }
  return projectRelativePath(path, roots.projectPath);
}

function addStringPath(paths: Set<string>, value: string | undefined, roots: ChangedFileRoots): void {
  if (!value?.trim()) return;
  paths.add(changedFilePath(value.trim(), roots));
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

function addPathsFromChange(paths: Set<string>, change: ChangedPath, roots: ChangedFileRoots): void {
  addStringPath(paths, change.path, roots);
  addStringPath(paths, change.filePath, roots);
  addStringPath(paths, change.file_path, roots);
  addStringPath(paths, change.filename, roots);
  addStringPath(paths, change.file, roots);
}

function addPathsFromParsed(paths: Set<string>, parsed: ChangedFileToolInput, roots: ChangedFileRoots): void {
  addPathsFromChange(paths, parsed, roots);
  for (const change of parsed.changes ?? []) addPathsFromChange(paths, change, roots);
}

function addPathsFromText(paths: Set<string>, input: string, roots: ChangedFileRoots): void {
  for (const match of input.matchAll(/"file_path"\s*:\s*"([^"]+)"/g)) {
    addStringPath(paths, match[1], roots);
  }
  for (const match of input.matchAll(/"filePath"\s*:\s*"([^"]+)"/g)) {
    addStringPath(paths, match[1], roots);
  }
  for (const match of input.matchAll(/"path"\s*:\s*"([^"]+)"/g)) {
    addStringPath(paths, match[1], roots);
  }
  for (const match of input.matchAll(/"filename"\s*:\s*"([^"]+)"/g)) {
    addStringPath(paths, match[1], roots);
  }
  // Command output can be large and is seldom a patch: split and parse it only
  // when it has a `diff --git` line.
  if (input.includes("diff --git")) {
    for (const file of patchFileChunks(input)) addStringPath(paths, file.path, roots);
  }
}

function collectMessagePaths(paths: Set<string>, m: Message, roots: ChangedFileRoots): void {
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
      if (parsed.success) addPathsFromParsed(paths, parsed.data, roots);
      else addPathsFromText(paths, m.toolInput, roots);
    } catch {
      addPathsFromText(paths, m.toolInput, roots);
    }
  }

  if (m.toolName === "exec_command" && m.content && !isGitCommand(m.toolInput)) {
    addPathsFromText(paths, m.content, roots);
  }
}

export function extractChangedFilePaths(
  messages: readonly Message[],
  roots: ChangedFileRoots = {},
): string[] {
  const paths = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    collectMessagePaths(paths, messages[i], roots);
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
  roots: ChangedFileRoots = {},
): string[] {
  const paths = new Set<string>();
  collectMessagePaths(paths, message, roots);
  return [...paths];
}

/**
 * Each path from `cwd`, as an absolute path. A file of a session folder beside
 * the working directory is named with `..` in front (`../api/src/a.ts`): the
 * answer is the real path of the file, with no `..` in it.
 */
export function toAbsoluteFilePaths(filePaths: readonly string[], cwd?: string): string[] {
  return filePaths.map((path) => {
    if (!cwd || isAbsoluteHostPath(path) || path.startsWith("~")) return path;
    const joined = joinHostPath(cwd, path);
    return hostPathSegments(path).some((name) => name === ".." || name === ".") ? normalizeHostPath(joined) : joined;
  });
}
