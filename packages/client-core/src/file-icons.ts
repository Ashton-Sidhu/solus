import { createFileTreeIconResolver, getBuiltInSpriteSheet, type FileTreeIcons } from "@pierre/trees";
import { hostPathBaseName } from "@solus/contracts/host-path";

// One configuration for native files, composer references, previews, and file trees.
const customSprite = `
<symbol id="solus-file-icon-agents" viewBox="0 0 24 24">
  <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="m8 9 3 3-3 3m5 0h3"/>
  </g>
</symbol>
<symbol id="solus-file-icon-pnpm" viewBox="0 0 32 32">
  <path fill="currentColor" d="M2 2h8v8H2zm10 0h8v8h-8zm10 0h8v8h-8zm-10 10h8v8h-8zm10 0h8v8h-8zM2 22h8v8H2zm10 0h8v8h-8zm10 0h8v8h-8z"/>
</symbol>
<symbol id="solus-file-icon-video" viewBox="0 0 24 24">
  <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 7h4m10 0h4M3 12h18M3 17h4m10 0h4"/>
  </g>
</symbol>
<symbol id="solus-file-icon-folder" viewBox="0 0 24 24">
  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M3 7V5a2 2 0 0 1 2-2h5l2 4h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h9"/>
</symbol>`;

export const FILE_TREE_ICONS = {
  set: "complete",
  colored: true,
  spriteSheet: `<svg xmlns="http://www.w3.org/2000/svg" data-icon-sprite width="0" height="0" aria-hidden="true">${customSprite}</svg>`,
  byFileName: {
    "agents.md": "solus-file-icon-agents",
    "package.json": "file-tree-builtin-npm",
    "tsconfig.json": "file-tree-builtin-typescript",
    "pnpm-lock.yaml": "solus-file-icon-pnpm",
    "pnpm-workspace.yaml": "solus-file-icon-pnpm",
  },
  byFileNameContains: { "tsconfig.": "file-tree-builtin-typescript" },
  byFileExtension: Object.fromEntries(
    ["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"].map((extension) => [extension, "solus-file-icon-video"]),
  ),
} satisfies FileTreeIcons;

const resolver = createFileTreeIconResolver(FILE_TREE_ICONS);

export const FILE_ICON_TOKENS = ["agents", "astro", "babel", "bash", "biome", "bootstrap", "browserslist", "bun", "c", "claude", "cpp", "css", "database", "default", "docker", "eslint", "font", "git", "go", "graphql", "html", "image", "javascript", "json", "markdown", "mcp", "nextjs", "npm", "oxc", "pnpm", "postcss", "prettier", "python", "react", "ruby", "rust", "sass", "stylelint", "svelte", "svg", "svgo", "swift", "table", "tailwind", "terraform", "text", "typescript", "video", "vite", "vscode", "vue", "wasm", "webpack", "yml", "zig", "zip", "folder"] as const;

export type FileIconToken = typeof FILE_ICON_TOKENS[number];

const tokensByName = new Map<string, FileIconToken>(FILE_ICON_TOKENS.map((token) => [
  ["agents", "pnpm", "video", "folder"].includes(token) ? `solus-file-icon-${token}` : `file-tree-builtin-${token}`, token,
]));

// Pierre's semantic file colors, with separate values for light and dark UI.
const FILE_ICON_COLORS = {
  agents: ["#84848a", "#adadb1"],
  astro: ["#a631be", "#d568ea"],
  babel: ["#d5a910", "#ffd452"],
  bash: ["#199f43", "#5ecc71"],
  biome: ["#1a85d4", "#69b1ff"],
  bootstrap: ["#693acf", "#9d6afb"],
  browserslist: ["#d5a910", "#ffd452"],
  bun: ["#594c5b", "#79697b"],
  c: ["#1a85d4", "#69b1ff"],
  claude: ["#d47628", "#ffa359"],
  cpp: ["#1a85d4", "#69b1ff"],
  css: ["#693acf", "#9d6afb"],
  database: ["#a631be", "#d568ea"],
  default: ["#84848a", "#adadb1"],
  docker: ["#1a85d4", "#69b1ff"],
  eslint: ["#693acf", "#9d6afb"],
  font: ["#84848a", "#adadb1"],
  git: ["#ff8c5b", "#d5512f"],
  go: ["#1ca1c7", "#68cdf2"],
  graphql: ["#d32a61", "#ff678d"],
  html: ["#d47628", "#ffa359"],
  image: ["#d32a61", "#ff678d"],
  javascript: ["#d5a910", "#ffd452"],
  json: ["#d47628", "#ffa359"],
  markdown: ["#199f43", "#5ecc71"],
  mcp: ["#17a5af", "#64d1db"],
  nextjs: ["#84848a", "#adadb1"],
  npm: ["#d52c36", "#ff6762"],
  oxc: ["#1ca1c7", "#68cdf2"],
  pnpm: ["#d5a910", "#ffd452"],
  postcss: ["#d52c36", "#ff6762"],
  prettier: ["#17a5af", "#64d1db"],
  python: ["#1a85d4", "#69b1ff"],
  react: ["#1ca1c7", "#68cdf2"],
  ruby: ["#d52c36", "#ff6762"],
  rust: ["#d47628", "#ffa359"],
  sass: ["#d32a61", "#ff678d"],
  stylelint: ["#84848a", "#adadb1"],
  svelte: ["#d52c36", "#ff6762"],
  svg: ["#d47628", "#ffa359"],
  svgo: ["#199f43", "#5ecc71"],
  swift: ["#d47628", "#ffa359"],
  table: ["#17a5af", "#64d1db"],
  tailwind: ["#1ca1c7", "#68cdf2"],
  terraform: ["#693acf", "#9d6afb"],
  text: ["#84848a", "#adadb1"],
  typescript: ["#1a85d4", "#69b1ff"],
  video: ["#a631be", "#d568ea"],
  vite: ["#a631be", "#d568ea"],
  vscode: ["#1a85d4", "#69b1ff"],
  vue: ["#199f43", "#5ecc71"],
  wasm: ["#693acf", "#9d6afb"],
  webpack: ["#1a85d4", "#69b1ff"],
  yml: ["#d52c36", "#ff6762"],
  zig: ["#d47628", "#ffa359"],
  zip: ["#d47628", "#ffa359"],
  folder: ["#84848a", "#adadb1"],
} as const satisfies Readonly<Record<FileIconToken, readonly [string, string]>>;

export function fileIconColor(token: FileIconToken, appearance: "light" | "dark"): string {
  return FILE_ICON_COLORS[token][appearance === "dark" ? 1 : 0];
}

function cssIconColor(token: FileIconToken): string {
  const [light, dark] = FILE_ICON_COLORS[token];
  return `light-dark(${light}, ${dark})`;
}

// Filename overrides do not receive Pierre's built-in color token. Apply the
// same palette by icon name so tree rows and individual file icons still match.
export const FILE_TREE_ICON_COLOR_CSS = [...tokensByName].map(([name, token]) =>
  `[data-item-section="icon"] [data-icon-name="${name}"] { color: ${cssIconColor(token)}; }`,
).join("\n");

// Parse the package's static sprite once. Each file contains only its own icon,
// with no document-global sprite or DOM lifecycle to maintain across tabs.
const icons = new Map<string, string>();
const coloredIcons = new Map<string, string>();
for (const match of `${getBuiltInSpriteSheet("complete")}${customSprite}`.matchAll(
  /<symbol id="([^"]+)"([^>]*)>([\s\S]*?)<\/symbol>/g,
)) {
  const svg = `<svg${match[2]} aria-hidden="true">${match[3]}</svg>`;
  icons.set(match[1], svg);
  coloredIcons.set(match[1], svg.replace("<svg", `<svg style="color:${cssIconColor(tokensByName.get(match[1]) ?? "default")}"`));
}

export function resolveFileIcon(path: string) {
  // Callers can pass an absolute host path, a Windows path, or a link position.
  const normalized = path.replace(/:\d+(?::\d+)?$/, "");
  const name = /[\\/]$/.test(normalized)
    ? "solus-file-icon-folder"
    : resolver.resolveIcon("file-tree-icon-file", hostPathBaseName(normalized)).name;
  return {
    name,
    token: tokensByName.get(name) ?? "default",
    svg: coloredIcons.get(name) ?? coloredIcons.get("file-tree-icon-file")!,
  };
}

/** Static SVG for native image generation; it uses the same symbols as the UI. */
export function fileIconSvg(token: FileIconToken): string {
  const name = [...tokensByName].find(([, value]) => value === token)?.[0];
  const svg = name && icons.get(name);
  if (!svg) throw new Error(`Missing file icon: ${token}`);
  return svg;
}
