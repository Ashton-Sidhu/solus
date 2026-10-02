import { describe, expect, test } from "bun:test";
import { faviconUrlForHref, selectedWebUrl } from "@solus/workspace-ui/components/conversation/lib/external-link";

describe("selected web addresses", () => {
  test("opens a complete address, including a host-local dev server", () => {
    expect(selectedWebUrl("  http://localhost:5173/page?next=/home#top  ")).toBe("http://localhost:5173/page?next=/home#top");
    expect(selectedWebUrl("https://example.com/path")).toBe("https://example.com/path");
    expect(selectedWebUrl("www.example.com/path")).toBe("https://www.example.com/path");
  });

  test("does not offer to open prose, multiple addresses, or non-web schemes", () => {
    for (const text of ["", "See https://example.com", "https://one.example https://two.example", "https://example.com/\ntext", "https:example", "file:///tmp/file", "javascript:alert(1)", "work://open?id=1", "example"]) {
      expect(selectedWebUrl(text)).toBeNull();
    }
  });
});

describe("external link favicons", () => {
  test("uses the website origin instead of the linked page path", () => {
    expect(
      faviconUrlForHref("https://docs.example.com/guides/start?from=chat"),
    ).toBe("https://docs.example.com/favicon.ico");
  });

  test("preserves HTTP origins and non-default ports", () => {
    expect(faviconUrlForHref("http://localhost:4173/docs")).toBe(
      "http://localhost:4173/favicon.ico",
    );
  });

  test("does not request icons for app links or malformed URLs", () => {
    expect(faviconUrlForHref("session://open?id=123")).toBeNull();
    expect(faviconUrlForHref("not a URL")).toBeNull();
  });
});
