import { FILE_ICON_TOKENS, FILE_TREE_ICONS, fileIconColor, resolveFileIcon } from "@solus/client-core/file-icons";
import { describe, expect, test } from "bun:test";
import { createFileTreeIconResolver } from "@pierre/trees";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

describe("conversation file icons", () => {
  // Filename rules must win over the extension, on every client. Otherwise
  // agent instructions look like ordinary Markdown and package files like JSON.
  test.each([
    ["docs/CONTRIBUTING.md", "markdown", "file-tree-builtin-markdown"],
    ["AGENTS.md", "agents", "solus-file-icon-agents"],
    ["C:\\project\\agents.MD", "agents", "solus-file-icon-agents"],
    ["package.json", "npm", "file-tree-builtin-npm"],
    ["tsconfig.json", "typescript", "file-tree-builtin-typescript"],
    ["tsconfig.app.json", "typescript", "file-tree-builtin-typescript"],
    ["pnpm-lock.yaml", "pnpm", "solus-file-icon-pnpm"],
    ["CLAUDE.md", "claude", "file-tree-builtin-claude"],
    ["src/main.ts", "typescript", "file-tree-builtin-typescript"],
    ["src/App.tsx", "react", "file-tree-builtin-react"],
    [".gitignore", "git", "file-tree-builtin-git"],
    ["file.unrecognized", "default", "file-tree-builtin-default"],
  ])("selects the file type for %s on web, desktop, and mobile", (path, nativeIcon, name) => {
    expect(resolveFileIcon(path).name).toBe(name);
    expect(resolveFileIcon(path).token).toBe(nativeIcon);
    if (!path.includes("\\")) {
      // Tree rows must not silently keep Pierre's default filename rules.
      expect(createFileTreeIconResolver(FILE_TREE_ICONS).resolveIcon("file-tree-icon-file", path).name).toBe(name);
    }
  });

  test("every shared icon has a visible native asset", () => {
    // Native Markdown cannot render the SVG directly. A missing or empty PNG
    // would make only the mobile client lose that icon.
    for (const token of FILE_ICON_TOKENS) {
      const data = readFileSync(new URL(`../../apps/mobile/assets/file-icons/pierre_${token}.png`, import.meta.url));
      const png = PNG.sync.read(data);
      expect(png.width).toBe(96);
      expect(png.height).toBe(96);
      expect(png.data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
    }
  });

  test.each(["light", "dark"] as const)("keeps file-type colors in %s mode", (appearance) => {
    const typescript = fileIconColor("typescript", appearance);
    const javascript = fileIconColor("javascript", appearance);
    const markdown = fileIconColor("markdown", appearance);
    const npm = fileIconColor("npm", appearance);
    // A link's blue text must not recolor every file type blue.
    expect(new Set([typescript, javascript, markdown, npm]).size).toBe(4);
    expect(resolveFileIcon("src/main.js").svg).toContain(javascript);
    expect(resolveFileIcon("CONTRIBUTING.md").svg).toContain(markdown);
    expect(resolveFileIcon("package.json").svg).toContain(npm);
    expect(FILE_TREE_ICONS.colored).toBe(true);
  });

  test("renders complete static SVG without inserting the file path into markup", () => {
    const icon = resolveFileIcon('<img src=x onerror="alert(1)">.md');
    expect(icon.svg).toContain('viewBox="0 0 16 16"');
    expect(icon.svg).toContain('style="color:light-dark(');
    expect(icon.svg).toContain("<path");
    expect(icon.svg).toEndWith("</svg>");
    expect(icon.svg).not.toContain("<symbol");
    expect(icon.svg).not.toContain("<img");
    expect(icon.svg).not.toContain("onerror");
  });
});
