import { describe, expect, mock, test } from "bun:test";
import {
  saveFileAsWorkCommands,
  visibleMarkdownFile,
} from "@solus/workspace-ui/components/files/lib/save-file-as-work";
import type { PaneEntry } from "@solus/workspace-ui/contexts/workspace/routing/location";

function pane(surface: PaneEntry["surfaces"][number] | null): PaneEntry {
  return { id: "pane", surfaces: surface ? [surface] : [], activeSurfaceIndex: 0 } as PaneEntry;
}

const chat = pane({ name: "chat", params: { tabId: "t1" } } as PaneEntry["surfaces"][number]);
const readme = pane({ name: "files", params: { serverId: "host-a", cwd: "/repo", path: "README.md" } });
const source = pane({ name: "files", params: { serverId: "host-a", cwd: "/repo", path: "src/index.ts" } });

describe("Save file as work", () => {
  test("offers the command only while a files pane shows a markdown file", () => {
    const saveFileAsWork = mock(async () => {});
    expect(saveFileAsWorkCommands({ router: { focused: chat, panes: [chat, source] }, saveFileAsWork })).toEqual([]);
    const [command] = saveFileAsWorkCommands({ router: { focused: chat, panes: [chat, readme] }, saveFileAsWork });
    expect(command?.id).toBe("save-file-as-work");
    command?.run?.();
    expect(saveFileAsWork).toHaveBeenCalledWith({ serverId: "host-a", cwd: "/repo", path: "README.md" });
  });

  test("prefers the focused pane's file when several panes show markdown", () => {
    const notes = pane({ name: "files", params: { serverId: "host-b", cwd: "/other", path: "NOTES.md" } });
    expect(visibleMarkdownFile({ focused: notes, panes: [readme, notes] })?.path).toBe("NOTES.md");
  });
});
