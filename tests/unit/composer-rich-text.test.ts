import { expect, test } from "bun:test";
import { isComposerCode, restoreComposerLinks } from "@solus/client-core/composer-rich-text";

test("restores each label at its matching position and keeps the plain line breaks", () => {
  const html = 'Guide <a href="https://example.com/?q=(a)&amp;next=2"><b>Guide</b><br>[next]</a>' +
    ' <a href="mailto:docs@example.com">email us</a>';
  expect(restoreComposerLinks("Guide Guide\r\n[next]\nemail us", html)).toBe(
    "Guide [Guide](https://example.com/?q=\\(a\\)&amp;next=2)\r\n" +
    "[\\[next\\]](https://example.com/?q=\\(a\\)&amp;next=2)\n[email us](mailto:docs@example.com)",
  );
});

test("restores an anchor beside hidden content, code and an unsupported destination", () => {
  const plain = "Value type API /docs setup";
  const html =
    '<script>ignored</script><span style="display: none">ignored</span>Value ' +
    '<code><a href="https://example.com/type">type</a></code> ' +
    '<pre><a href="https://example.com/api">API</a></pre> ' +
    '<a href="/docs">/docs</a> <span style="visibility:hidden">ignore this' +
    '<a style="visibility:visible" href="https://example.com/setup">setup</a></span>';
  expect(restoreComposerLinks(plain, html)).toBe("Value type API /docs [setup](https://example.com/setup)");
});

test("leaves plain text alone when HTML does not reliably identify an external link", () => {
  expect(restoreComposerLinks("Guide Guide", '<a href="https://example.com">Guide</a>')).toBeNull();
  expect(restoreComposerLinks("Guide", '<a href="javascript:alert(1)">Guide</a>')).toBeNull();
  expect(restoreComposerLinks("[Guide](https://example.com)", "")).toBeNull();
  expect(restoreComposerLinks("https://example.com", '<a href="https://example.com">https://example.com</a>')).toBeNull();
});

test("keeps links clickable after a literal backslash or exclamation mark", () => {
  const html = '<a href="https://example.com">Guide</a>';
  expect(restoreComposerLinks("\\Guide", "\\" + html)).toBe("\\\\[Guide](https://example.com)");
  expect(restoreComposerLinks("!Guide", "!" + html)).toBe("\\![Guide](https://example.com)");
});

test("detects a paste inside inline, indented and fenced code", () => {
  expect(isComposerCode("Use `example` here", 8)).toBe(true);
  expect(isComposerCode("Use `example` here", 5, 12)).toBe(true);
  expect(isComposerCode("Use `example` here", 13)).toBe(false);
  expect(isComposerCode("    example", 11)).toBe(true);
  expect(isComposerCode("```\nexample\n", 12)).toBe(true);
  expect(isComposerCode("```\nexample\n```", 15)).toBe(false);
});
