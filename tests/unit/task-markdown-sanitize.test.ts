import { describe, expect, test } from "bun:test";
import { isInlineTaskImageUrl } from "@solus/workspace-ui/components/tasks/task-page/lib/task-image";

describe("task markdown images", () => {
  test("recognizes pasted raster screenshots", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(isInlineTaskImageUrl(png)).toBe(true);
    expect(isInlineTaskImageUrl("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
  });

  test("rejects executable and non-image data URLs", () => {
    expect(
      isInlineTaskImageUrl(
        "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
      ),
    ).toBe(false);
    expect(isInlineTaskImageUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isInlineTaskImageUrl("javascript:alert(1)")).toBe(false);
  });
});
