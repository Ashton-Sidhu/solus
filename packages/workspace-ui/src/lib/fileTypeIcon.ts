// Maps a file path to a vibrant Iconify `logos:` icon name for known languages,
// or null when the type has no brand logo. A build-time subset keeps only these
// icons locally; @iconify/svelte re-renders once that subset registers.

// Full filename matches (no extension) take priority over extension lookup.
const ICON_BY_FILENAME = new Map([["dockerfile", "logos:docker-icon"]]);

const ICON_BY_EXT = new Map(Object.entries({
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
}));

export const FILE_TYPE_ICON_NAMES = Array.from(
  new Set([...ICON_BY_FILENAME.values(), ...ICON_BY_EXT.values()]),
);

export function fileTypeIcon(path: string): string | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const filenameIcon = ICON_BY_FILENAME.get(name);
  if (filenameIcon) return filenameIcon;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return ICON_BY_EXT.get(name.slice(dot + 1)) ?? null;
}
