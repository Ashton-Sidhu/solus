import { describe, expect, test } from "bun:test";
import {
  basename,
  codeSpanFileTarget,
  leadingDirs,
  parentDir,
} from "@solus/workspace-ui/components/ui/lib/code-span-path";

describe("file code-span chip path", () => {
  test("the parts a chip shows and hides rebuild the whole path", () => {
    // WHY: the chip has room for two segments, so copying a message used to
    // paste a partial path that no longer names a file. The copy-only part in
    // front of the label is what makes the selection carry the rest.
    for (const path of [
      "packages/workspace-ui/src/index.css",
      "src/App.svelte",
      "README.md",
      "./scripts/build.ts",
    ]) {
      expect(leadingDirs(path) + parentDir(path) + basename(path)).toBe(path);
    }
  });

  test("hides only what the chip cannot show", () => {
    expect(leadingDirs("packages/workspace-ui/src/index.css")).toBe(
      "packages/workspace-ui/",
    );
    expect(parentDir("packages/workspace-ui/src/index.css")).toBe("src/");
    expect(basename("packages/workspace-ui/src/index.css")).toBe("index.css");
  });

  test("a path the chip shows whole hides nothing", () => {
    expect(leadingDirs("src/App.svelte")).toBe("");
    expect(leadingDirs("README.md")).toBe("");
    expect(parentDir("README.md")).toBe("");
  });
});

describe("which code spans name a file", () => {
  // WHY: a code span that is a file opens it in one click, but most code spans
  // are identifiers, refs, hosts, and routes. A chip on `origin/main` opens a
  // preview of nothing. Desktop and web must agree with mobile, which runs the
  // same T3 rule.
  test("a path with real evidence becomes a file chip", () => {
    expect(codeSpanFileTarget("src/App.svelte")).toEqual({ path: "src/App.svelte" });
    expect(codeSpanFileTarget("src/App.svelte:42")).toEqual({ path: "src/App.svelte", line: 42 });
    expect(codeSpanFileTarget("src/App.svelte:42:7")).toEqual({ path: "src/App.svelte", line: 42 });
    expect(codeSpanFileTarget("App.svelte:42")).toEqual({ path: "App.svelte", line: 42 });
    expect(codeSpanFileTarget("./scripts/build")).toEqual({ path: "./scripts/build" });
    expect(codeSpanFileTarget("~/notes/todo")).toEqual({ path: "~/notes/todo" });
    expect(codeSpanFileTarget("/Users/me/repo/bin/run")).toEqual({ path: "/Users/me/repo/bin/run" });
    expect(codeSpanFileTarget("/srv/app/main.ts")).toEqual({ path: "/srv/app/main.ts" });
    expect(codeSpanFileTarget("docker/Dockerfile")).toEqual({ path: "docker/Dockerfile" });
    expect(codeSpanFileTarget("Makefile:12")).toEqual({ path: "Makefile", line: 12 });
    expect(codeSpanFileTarget("conf.d/site.conf")).toEqual({ path: "conf.d/site.conf" });
    expect(codeSpanFileTarget("src\\lib\\a.ts")).toEqual({ path: "src/lib/a.ts" });
    expect(codeSpanFileTarget("C:\\repo\\a.ts")).toEqual({ path: "C:\\repo\\a.ts" });
  });

  test("an identifier, ref, host, route, or version stays code", () => {
    for (const text of [
      "node.meta",
      "origin/main",
      "feature/new-thing",
      "@solus/contracts",
      "github.com/x/y.ts",
      "localhost:5173",
      "127.0.0.1:8080",
      "port:3000",
      "TODO:12",
      "/api/sessions",
      "models/glm-5.3",
      "src/",
      "bun test tests/unit/a.ts",
      "",
    ]) {
      expect(codeSpanFileTarget(text)).toBeNull();
    }
  });
});
