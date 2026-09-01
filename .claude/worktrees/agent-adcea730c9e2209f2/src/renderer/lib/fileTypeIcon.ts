// Maps a file path to a vibrant Iconify `logos:` icon name for known languages,
// or null when the type has no brand logo — callers fall back to the monochrome
// extension badge. The `logos` collection is ~12MB and lazy-loaded on demand
// (see ensureIconCollections); @iconify/svelte re-renders once it registers.

// Full filename matches (no extension) take priority over extension lookup.
const ICON_BY_FILENAME: Record<string, string> = {
  dockerfile: "logos:docker-icon",
};

const ICON_BY_EXT: Record<string, string> = {
  ts: "logos:typescript-icon",
  mts: "logos:typescript-icon",
  cts: "logos:typescript-icon",
  tsx: "logos:react",
  js: "logos:javascript",
  mjs: "logos:javascript",
  cjs: "logos:javascript",
  jsx: "logos:react",
  svelte: "logos:svelte-icon",
  vue: "logos:vue",
  py: "logos:python",
  rb: "logos:ruby",
  go: "logos:go",
  rs: "logos:rust",
  java: "logos:java",
  kt: "logos:kotlin-icon",
  swift: "logos:swift",
  c: "logos:c",
  h: "logos:c",
  cc: "logos:c-plusplus",
  cpp: "logos:c-plusplus",
  hpp: "logos:c-plusplus",
  cs: "logos:c-sharp",
  php: "logos:php",
  css: "logos:css-3",
  scss: "logos:sass",
  sass: "logos:sass",
  html: "logos:html-5",
  htm: "logos:html-5",
  json: "logos:json",
  yaml: "logos:yaml",
  yml: "logos:yaml",
  sh: "logos:bash-icon",
  bash: "logos:bash-icon",
  zsh: "logos:bash-icon",
  graphql: "logos:graphql",
  gql: "logos:graphql",
  md: "logos:markdown",
  mdx: "logos:markdown",
  sql: "logos:postgresql",
};

export function fileTypeIcon(path: string): string | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (name in ICON_BY_FILENAME) return ICON_BY_FILENAME[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return ICON_BY_EXT[name.slice(dot + 1)] ?? null;
}
