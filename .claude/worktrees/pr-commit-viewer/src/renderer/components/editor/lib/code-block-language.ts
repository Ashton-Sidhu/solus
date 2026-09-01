const CODE_BLOCK_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  "c++": "cpp",
  html: "xml",
  js: "javascript",
  md: "markdown",
  py: "python",
  ts: "typescript",
  yml: "yaml",
};

const CODE_BLOCK_LANGUAGES = new Set([
  "",
  "bash",
  "c",
  "cpp",
  "css",
  "go",
  "java",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "shell",
  "sql",
  "typescript",
  "xml",
  "yaml",
]);

/** Resolve common Markdown fence aliases to the values offered by the picker. */
export function codeBlockPickerLanguage(language: string | null | undefined): string {
  if (!language) return "";
  const normalized = language.toLowerCase();
  if (CODE_BLOCK_LANGUAGES.has(normalized)) return normalized;
  return CODE_BLOCK_LANGUAGE_ALIASES[normalized] ?? "";
}
