import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const directoryPicker = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/pickers/DirectoryPicker.svelte",
  ),
  "utf8",
);

describe("directory picker layout", () => {
  test("uses more of laptop and desktop displays without changing the mobile sheet", () => {
    // WHY: the folder list and its action footer were cramped inside the old
    // 56rem by 50vh desktop dialog, especially on laptop displays.
    expect(directoryPicker).toContain(
      "h-[clamp(28rem,65vh,43rem)] w-[clamp(42rem,72vw,64rem)]",
    );
    expect(directoryPicker).toContain(
      "md:pointer-fine:[.is-laptop-display_&]:h-[72%] md:pointer-fine:[.is-laptop-display_&]:w-[88%]",
    );
    expect(directoryPicker).toContain("max-md:h-[90dvh] max-md:w-full");
  });

  test("removes redundant keyboard hints from the laptop footer", () => {
    // WHY: the path, file-manager action, Cancel, and Select are useful state
    // or actions. Keyboard hints can leave when the footer needs room, and
    // keyboard behavior remains intact.
    expect(directoryPicker.match(/pointer-fine:\[\.is-laptop-display_&\]:hidden/g)).toHaveLength(2);
    expect(directoryPicker).not.toContain("{dirEntries.length} folders");
    expect(directoryPicker).toContain("Open in {fileManagerName}");
  });
});
