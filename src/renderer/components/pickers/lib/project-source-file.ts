export type ProjectSourceKind = "doc" | "slides" | "diagram" | "plan";

export function projectSourceFileName(title: string, kind: ProjectSourceKind): string {
  const baseName = title.replace(/[^\w.\- ]+/g, "_").trim() || (kind === "plan" ? "plan" : "work");
  return `${baseName}.${kind === "diagram" ? "json" : "md"}`;
}

export function projectSourcePath(directory: string, fileName: string): string {
  return `${directory.replace(/[\\/]+$/, "")}/${fileName}`;
}
