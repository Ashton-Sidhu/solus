import { describe, expect, it } from "bun:test";
import { selectSessionRename } from "../../src/renderer/components/session/lib/session-context-menu";

describe("session context menu", () => {
  it("keeps the selected tab available after closing the reactive menu target", () => {
    let selectedTabId: string | null = "tab-1";
    let renamedTabId: string | null = null;

    selectSessionRename({
      tabId: selectedTabId,
      onStartRename: (tabId) => {
        renamedTabId = tabId;
      },
      onDefaultRename: () => {
        throw new Error("sidebar rename should override the default dialog");
      },
      onClose: () => {
        selectedTabId = null;
      },
    });

    expect(selectedTabId).toBeNull();
    expect(renamedTabId).toBe("tab-1");
  });
});
