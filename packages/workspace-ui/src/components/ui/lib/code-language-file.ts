// Fence names that are not a file extension. Most fences (ts, py, rs, go, sh,
// css, json, yaml, svelte, …) are one already and need no entry.
const FILE_NAME_BY_LANGUAGE = new Map([
  ["c++", "x.cpp"],
  ["console", "x.sh"],
  ["docker", "Dockerfile"],
  ["dockerfile", "Dockerfile"],
  ["golang", "x.go"],
  ["hcl", "x.tf"],
  ["javascript", "x.js"],
  ["markdown", "x.md"],
  ["python", "x.py"],
  ["ruby", "x.rb"],
  ["rust", "x.rs"],
  ["shell", "x.sh"],
  ["shellscript", "x.sh"],
  ["terraform", "x.tf"],
  ["typescript", "x.ts"],
]);

/** A file name that gives a fence's language its file icon, as T3 Code's
 *  `syntheticFileNameForLanguageId` does. A block with no language or a plain
 *  text one resolves to the generic icon, which the header does not show. */
export function codeLanguageFileName(language: string | undefined): string {
  const name = language?.trim().toLowerCase() || "text";
  return FILE_NAME_BY_LANGUAGE.get(name) ?? `x.${name}`;
}
