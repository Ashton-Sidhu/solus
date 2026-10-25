import { describe, expect, test } from "bun:test";
import { fileMenuItem } from "@solus/workspace-ui/components/editor/unified-autocomplete/rows";

// WHY: the title column is capped at 20rem for a short file name. When the split
// missed, a whole absolute path went into the title and every row was cut to
// the same prefix, so the file names were never visible.
describe("file menu item", () => {
  test("splits a POSIX path into name and folder", () => {
    const item = fileMenuItem("src/lib/readme.md", false);
    expect(item.title).toBe("readme.md");
    expect(item.meta).toBe("src/lib/");
  });

  test("splits a Windows path from a Windows host into name and folder", () => {
    const item = fileMenuItem("C:\\code\\scratch\\src\\readme.md", false);
    expect(item.title).toBe("readme.md");
    expect(item.meta).toBe("C:\\code\\scratch\\src\\");
    expect(item.token).toEqual({ kind: "file", path: "C:\\code\\scratch\\src\\readme.md", name: "readme.md" });
  });

  test("names a Windows folder by its last segment", () => {
    const item = fileMenuItem("C:\\code\\scratch\\src/", true, "C:\\code\\scratch\\src");
    expect(item.title).toBe("src/");
    expect(item.meta).toBe("C:\\code\\scratch\\");
  });
});
