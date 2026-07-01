import type { Message } from "../../shared/types";

export function isGitCommand(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const trimmed = command.trim();
  const shellWrapped = trimmed.match(/^(?:\/\S+\/)?(?:sh|bash|zsh)\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*c[A-Za-z]*\s+(?:'([^']*)'|"([^"]*)"|(.+))$/);
  if (shellWrapped) {
    return isGitCommand(shellWrapped[1] ?? shellWrapped[2] ?? shellWrapped[3] ?? "");
  }

  return /(?:^|[;&|]\s*|&&\s*|\|\|\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:\S+\/)?git(?:\s|$)/.test(trimmed);
}

function addStringPath(paths: Set<string>, value: unknown, projectPath?: string): void {
  if (typeof value !== "string" || !value.trim()) return;
  let path = value.trim();
  const prefix = projectPath ? projectPath.replace(/\/$/, "") + "/" : "";
  if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
  paths.add(path);
}

function addPathsFromChange(paths: Set<string>, change: unknown, projectPath?: string): void {
  if (!change || typeof change !== "object") return;
  const record = change as Record<string, unknown>;
  addStringPath(paths, record.path, projectPath);
  addStringPath(paths, record.filePath, projectPath);
  addStringPath(paths, record.file_path, projectPath);
  addStringPath(paths, record.filename, projectPath);
  addStringPath(paths, record.file, projectPath);
}

function addPathsFromParsed(paths: Set<string>, parsed: unknown, projectPath?: string): void {
  if (!parsed || typeof parsed !== "object") return;
  const record = parsed as Record<string, unknown>;
  addStringPath(paths, record.file_path, projectPath);
  addStringPath(paths, record.filePath, projectPath);
  addStringPath(paths, record.path, projectPath);
  addStringPath(paths, record.filename, projectPath);
  addStringPath(paths, record.file, projectPath);

  if (Array.isArray(record.changes)) {
    for (const change of record.changes) addPathsFromChange(paths, change, projectPath);
  }
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

export function extractChangedFilePaths(
  messages: readonly Message[],
  opts: { projectPath?: string } = {},
): string[] {
  const paths = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.role !== "tool" ||
      m.toolStatus !== "completed" ||
      (m.toolName !== "Write" && m.toolName !== "Edit" && m.toolName !== "exec_command")
    ) {
      continue;
    }

    if (m.toolInput) {
      try {
        addPathsFromParsed(paths, JSON.parse(m.toolInput), opts.projectPath);
      } catch {
        addPathsFromText(paths, m.toolInput, opts.projectPath);
      }
    }

    if (m.toolName === "exec_command" && m.content && !isGitCommand(m.toolInput)) {
      addPathsFromText(paths, m.content, opts.projectPath);
    }
  }

  return [...paths];
}

export function toAbsoluteFilePaths(filePaths: readonly string[], cwd?: string): string[] {
  const root = cwd?.replace(/\/$/, "");
  return filePaths.map((path) => {
    if (!root || path.startsWith("/") || path.startsWith("~")) return path;
    return `${root}/${path}`;
  });
}
