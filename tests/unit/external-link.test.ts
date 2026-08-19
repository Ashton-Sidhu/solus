import { describe, expect, test } from "bun:test";
import { faviconUrlForHref } from "@solus/workspace-ui/components/conversation/lib/external-link";

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
