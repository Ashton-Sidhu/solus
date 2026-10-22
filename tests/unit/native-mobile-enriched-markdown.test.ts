// Adapted from T3 Code apps/mobile/src/lib/markdownLinks.test.ts, enrichedLinkPresentation.test.ts, and markdownHtml.test.ts (MIT, see apps/mobile/UPSTREAM.md).
import { describe, expect, it } from "bun:test";

import {
  ENRICHED_INLINE_FILE_LINK_REGEX,
  enrichedLinkVariantPattern,
} from "../../apps/mobile/src/lib/enrichedLinkPresentation";
import {
  markdownHtmlContent,
  markdownWithBlockImages,
  markdownWithHtml,
} from "../../apps/mobile/src/lib/markdownDocument";
import {
  resolveMarkdownLinkIcon,
  resolveMarkdownLinkPresentation,
} from "../../apps/mobile/src/lib/markdownLinks";

describe("resolveMarkdownLinkIcon", () => {
  it("gives GitHub hosts the brand mark and everything else the generic glyph", () => {
    expect(resolveMarkdownLinkIcon("github.com")).toBe("github");
    expect(resolveMarkdownLinkIcon("GitHub.com")).toBe("github");
    expect(resolveMarkdownLinkIcon("gist.github.com")).toBe("github");
    expect(resolveMarkdownLinkIcon("github.community")).toBeNull();
    expect(resolveMarkdownLinkIcon("notgithub.com")).toBeNull();
    expect(resolveMarkdownLinkIcon("example.com")).toBeNull();
  });
});

describe("resolveMarkdownLinkPresentation", () => {
  it("reads a session link an agent wrote as that session, on its own host or the transcript's", () => {
    // WHY: agents link the sessions they start. On a phone the link was dead,
    // so the person could not open the worker the reply named.
    expect(
      resolveMarkdownLinkPresentation("session://open?provider=codex&sessionId=worker-1&serverId=studio&cwd=%2Frepo"),
    ).toEqual({
      kind: "session",
      href: "session://open?provider=codex&sessionId=worker-1&serverId=studio&cwd=%2Frepo",
      sessionId: "worker-1",
      serverId: "studio",
    });
    expect(resolveMarkdownLinkPresentation("session://ref?provider=claude-code&sessionId=s2")).toMatchObject({
      kind: "session",
      sessionId: "s2",
      serverId: null,
    });
    // An unknown provider or a missing id is not a session the app can open.
    expect(resolveMarkdownLinkPresentation("session://open?provider=other&sessionId=s3")).toEqual({ kind: "link", href: null });
    expect(resolveMarkdownLinkPresentation("session://open?provider=codex")).toEqual({ kind: "link", href: null });
  });

  it("treats protocol-relative media as an external URL, not a filesystem path", () => {
    expect(resolveMarkdownLinkPresentation("//cdn.example.com/clip.mp4?sig=a%2fb#t=2")).toEqual({
      kind: "external",
      href: "https://cdn.example.com/clip.mp4?sig=a%2fb#t=2",
      host: "cdn.example.com",
    });
  });

  it("separates encoded filename characters from a video playback fragment", () => {
    expect(resolveMarkdownLinkPresentation("/tmp/clip%23one.mp4#t=2")).toMatchObject({
      path: "/tmp/clip#one.mp4",
      label: "clip#one.mp4",
      icon: "video",
    });
  });

  it("extracts external link hosts", () => {
    expect(resolveMarkdownLinkPresentation("https://example.com/docs?q=1")).toEqual({
      kind: "external",
      href: "https://example.com/docs?q=1",
      host: "example.com",
    });
  });

  it.each([
    ["file:///Users/julius/project/src/main.ts#L42C7", "/Users/julius/project/src/main.ts"],
    ["file://server/share/src/main.ts#L42C7", "\\\\server\\share\\src\\main.ts"],
  ])("preserves the file URL path and position for %s", (href, path) => {
    expect(resolveMarkdownLinkPresentation(href)).toEqual({
      kind: "file",
      href,
      icon: "typescript",
      label: "main.ts:42:7",
      path,
      line: 42,
      column: 7,
    });
  });

  // T3 #21403: a folder link is a chip that opens the file browser; a bare
  // extensionless word stays a plain link, so prose like [docs](docs) is not a path.
  it("makes relative folder links file chips, but not bare words", () => {
    expect(resolveMarkdownLinkPresentation("src/")).toMatchObject({ kind: "file", path: "src/", label: "src" });
    expect(resolveMarkdownLinkPresentation("docs/My Folder/")).toMatchObject({ kind: "file", path: "docs/My Folder/" });
    expect(resolveMarkdownLinkPresentation("docs")).toEqual({ kind: "link", href: null });
  });

  it("recognizes relative source paths and bare filenames", () => {
    expect(resolveMarkdownLinkPresentation("apps/mobile/src/index.ts:10")).toEqual({
      kind: "file",
      href: "apps/mobile/src/index.ts:10",
      icon: "typescript",
      label: "index.ts:10",
      path: "apps/mobile/src/index.ts",
      line: 10,
    });
    expect(resolveMarkdownLinkPresentation("AGENTS.md")).toEqual({
      kind: "file",
      href: "AGENTS.md",
      icon: "agents",
      label: "AGENTS.md",
      path: "AGENTS.md",
    });
    expect(resolveMarkdownLinkPresentation("package.json")).toEqual({
      kind: "file",
      href: "package.json",
      icon: "npm",
      label: "package.json",
      path: "package.json",
    });
  });

  it.each(["md", "html", "xml"])("recognizes a bare spaced .%s filename", (extension) => {
    expect(
      resolveMarkdownLinkPresentation(`Updated%20cutover%20checklist.${extension}`),
    ).toMatchObject({
      kind: "file",
      path: `Updated cutover checklist.${extension}`,
      label: `Updated cutover checklist.${extension}`,
    });
  });

  it("extracts line fragments from relative file links", () => {
    expect(resolveMarkdownLinkPresentation("src/main.ts#L18C2")).toMatchObject({
      kind: "file",
      path: "src/main.ts",
      line: 18,
      column: 2,
      label: "main.ts:18:2",
    });
  });

  it("uses the Pierre complete icon mappings", () => {
    expect(resolveMarkdownLinkPresentation("src/Button.tsx")).toMatchObject({ icon: "react" });
    expect(resolveMarkdownLinkPresentation("vite.config.ts")).toMatchObject({ icon: "vite" });
    expect(resolveMarkdownLinkPresentation("Dockerfile")).toMatchObject({ icon: "docker" });
    expect(resolveMarkdownLinkPresentation("pnpm-lock.yaml")).toMatchObject({ icon: "pnpm" });
  });

  it("does not style app routes as file links, and only mail and phone links keep an href", () => {
    expect(resolveMarkdownLinkPresentation("/chat/settings")).toEqual({ kind: "link", href: null });
    expect(resolveMarkdownLinkPresentation("mailto:team@example.com")).toEqual({
      kind: "link",
      href: "mailto:team@example.com",
    });
  });
});

describe("Enriched link presentation", () => {
  it("recognizes file-shaped code without turning commands or URLs into links", () => {
    for (const path of [
      "src/app.tsx",
      "./README.md",
      "/tmp/report.md",
      "C:\\repo\\app.tsx",
      "app.tsx:12:3",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(path)).toBe(true);
    }
    for (const text of [
      "npm run dev",
      "port:3000",
      "TODO:12",
      "example.com",
      "https://example.com/app.tsx",
      "x + y",
      "README.md",
      "/app/settings",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(text)).toBe(false);
    }
  });

  it("a code span Enriched recognizes opens as a file link", () => {
    // WHY: Enriched hands the recognized span to the link press as its URL;
    // the press opens the Solus file screen only when it resolves to a file.
    for (const path of ["src/app.tsx", "./README.md", "/tmp/report.md", "app.tsx:12:3"]) {
      expect(resolveMarkdownLinkPresentation(path).kind).toBe("file");
    }
  });

  it("matches only the complete URL, including literal regex metacharacters", () => {
    const url = "file:///workspace/app[1].tsx?line=3+4";
    const pattern = new RegExp(enrichedLinkVariantPattern(url));
    expect(pattern.test(url)).toBe(true);
    expect(pattern.test(`${url}/child`)).toBe(false);
    expect(pattern.test("file:///workspace/app1Xtsx?line=34")).toBe(false);
  });
});

describe("HTML in native Markdown", () => {
  it("leaves code inside an HTML details block literal", () => {
    const content =
      '<details>\n<summary>Example</summary>\n\n```html\n<img src="literal.png">\n```\n\nUse `<img>` here.\n</details>';
    const result = markdownHtmlContent(content);
    expect(result).toContain('```html\n<img src="literal.png">\n```');
    expect(result).toContain("Use `<img>` here.");
    expect(result).not.toContain("<details>");
  });

  it("preserves screenshot URLs and captions from GitHub HTML image embeds", () => {
    expect(
      markdownHtmlContent(
        '<img width="900" alt="Before > after [settings]" src="https://example.com/before.png?a=1&amp;b=2" />',
      ),
    ).toBe("![Before > after \\[settings\\]](<https://example.com/before.png?a=1\\&b=2>)");
    expect(
      markdownHtmlContent(
        "<a href='https://example.com'><img src='https://example.com/banner.svg' alt='Review' /></a>",
      ),
    ).toBe("![Review](<https://example.com/banner.svg>)");
  });

  it("decodes HTML attributes once and preserves entity-shaped query values through Markdown", () => {
    const markdown =
      '<img alt="&amp;lt;" src="https://example.com/shot.png?label=&amp;lt;&amp;sig=a%26b">';
    expect(markdownWithHtml(markdown)).toBe(
      "![\\&lt;](<https://example.com/shot.png?label=\\&lt;\\&sig=a%26b>)",
    );
  });

  it("ignores code delimiters in HTML attributes and comments", () => {
    const markdown =
      '<details data-example="`">\n<summary>Proof</summary>\n<img src="https://example.com/shot.png" alt="Screenshot">\n<!-- ` -->\n</details>';
    expect(markdownHtmlContent(markdown)).toContain(
      "![Screenshot](<https://example.com/shot.png>)",
    );
    expect(markdownWithHtml(markdown)).not.toContain("<img");
  });

  it("removes bot metadata and details wrappers while keeping the content", () => {
    const markdown =
      "<!-- generated bot metadata -->\n<details>\n<summary>Walkthrough</summary>\n\n## Changes\n\nText\n\n</details>";
    const result = markdownWithHtml(markdown);
    expect(result).not.toContain("<!--");
    expect(result).not.toContain("<details>");
    expect(result).toContain("**Walkthrough**");
    expect(result).toContain("## Changes");
  });

  it("leaves inline and fenced code literal and Markdown without HTML unchanged", () => {
    const markdown =
      '```html\n<img src="literal.png">\n```\n\nUse `<img src="inline.png">` here.\n\n<img src="one.png">';
    const result = markdownWithHtml(markdown);
    expect(result).toContain('```html\n<img src="literal.png">\n```');
    expect(result).toContain('`<img src="inline.png">`');
    expect(result).toContain("![](<one.png>)");
    const plain = "# Title\n\nNo tags, `a < b`.";
    expect(markdownWithHtml(plain)).toBe(plain);
  });
});

describe("Images on a line of their own", () => {
  // Enriched draws an image that shares a paragraph with text as a 20pt icon.
  it("moves a captioned screenshot into its own paragraph", () => {
    const markdown = "**Step 1: Sign in**\n![](/tmp/shot.png)\n\n**Step 2**  \n![Tools](</tmp/a b.png>) \\\nAfter";
    expect(markdownWithBlockImages(markdown)).toBe(
      "**Step 1: Sign in**\n\n![](/tmp/shot.png)\n\n**Step 2**\n\n![Tools](</tmp/a b.png>)\n\nAfter",
    );
  });

  it("keeps an image inside a sentence, list, quote, or code inline", () => {
    const markdown =
      "Build ![badge](b.svg) passing\n\n- Item\n  ![](l.png)\n\n> Quote\n> ![](q.png)\n\n```md\nText\n![](c.png)\n```\n\n![](alone.png)";
    expect(markdownWithBlockImages(markdown)).toBe(markdown);
  });
});
