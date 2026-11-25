import { describe, expect, test } from "bun:test";
import { resolveFileIcon } from "@solus/client-core/file-icons";
import { codeLanguageFileName } from "@solus/workspace-ui/components/ui/lib/code-language-file";

const iconOf = (language: string | undefined) => resolveFileIcon(codeLanguageFileName(language)).token;

describe("code block language icon", () => {
  test("a fence written as the full language name gets that language's icon", () => {
    expect(iconOf("typescript")).toBe("typescript");
    expect(iconOf("python")).toBe("python");
    expect(iconOf("rust")).toBe("rust");
    expect(iconOf("shell")).toBe("bash");
    expect(iconOf("dockerfile")).toBe("docker");
  });

  test("a fence written as an extension gets the same icon as a file of that type", () => {
    expect(iconOf("ts")).toBe("typescript");
    expect(iconOf("tsx")).toBe("react");
    expect(iconOf("yml")).toBe("yml");
    expect(iconOf("svelte")).toBe("svelte");
  });

  test("case and spaces in the fence do not change the icon", () => {
    expect(iconOf(" TypeScript ")).toBe("typescript");
  });

  // The header shows no generic icon, as on T3 Code's PR page: a plain block
  // or an unknown language keeps its label alone.
  test("a block with no language, plain text, or an unknown language has no icon of its own", () => {
    for (const language of [undefined, "", "text", "plaintext", "brainfudge"]) {
      expect(iconOf(language)).toBe("default");
    }
  });
});
