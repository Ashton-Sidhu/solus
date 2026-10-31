import { describe, expect, test } from "bun:test";
import { webLinkIcon } from "@solus/client-core/web-link-icon";
import { selectedWebUrl } from "@solus/workspace-ui/components/conversation/lib/external-link";

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

describe("external link icons", () => {
  test("uses Google for the hostname without sending the page path, credentials, or port", () => {
    expect(webLinkIcon("https://user:password@docs.example.com:8443/guides/start?token=secret#top")).toEqual({
      kind: "favicon",
      url: "https://www.google.com/s2/favicons?domain=docs.example.com&sz=32",
    });
    expect(webLinkIcon("http://docs.litellm.ai/docs/contributing")).toEqual({
      kind: "favicon",
      url: "https://www.google.com/s2/favicons?domain=docs.litellm.ai&sz=32",
    });
  });

  test("uses a built-in GitHub mark, including subdomains", () => {
    expect(webLinkIcon("https://github.com/org/repo")).toEqual({ kind: "github" });
    expect(webLinkIcon("https://GIST.GITHUB.COM/user/id")).toEqual({ kind: "github" });
    expect(webLinkIcon("https://notgithub.com")).toMatchObject({ kind: "favicon" });
  });

  test("keeps local addresses out of the third-party service and shows a globe", () => {
    for (const host of ["localhost:4173", "127.0.0.1", "192.168.1.5", "10.0.0.2", "[::1]", "[fd00::1]", "studio", "studio.local", "studio.internal", "app.localhost", "app.test", "studio.local."]) {
      expect(webLinkIcon(`http://${host}/docs`)).toEqual({ kind: "globe" });
    }
  });

  test("does not decorate app links, files, email links, or malformed URLs", () => {
    for (const href of ["session://open?id=123", "work://open?id=1", "/tmp/file.md", "mailto:user@example.com", "not a URL"]) {
      expect(webLinkIcon(href)).toBeNull();
    }
  });
});
