import { describe, expect, test } from "bun:test";
import type { SessionReference } from "@solus/contracts/types";
import { parseSessionHref } from "@solus/contracts/session-link";
import {
  extractTrackedReferences,
  parseReferenceTokens,
} from "@solus/workspace-ui/components/editor/reference-tokens";
import {
  SESSION_DRAG_TYPE,
  carriesSessionDrag,
  readSessionDrag,
  sessionDropInsertion,
  writeSessionDrag,
} from "@solus/workspace-ui/lib/session-drag";

/** The part of a DataTransfer a drag writes and a drop reads. */
class FakeDataTransfer {
  readonly data = new Map<string, string>();
  effectAllowed: DataTransfer["effectAllowed"] = "uninitialized";
  get types(): string[] {
    return [...this.data.keys()];
  }
  setData(format: string, value: string) {
    this.data.set(format, value);
  }
  getData(format: string): string {
    return this.data.get(format) ?? "";
  }
}

const remote: SessionReference = {
  sessionId: "sess-remote-1",
  provider: "codex",
  title: "Fix [flaky] login test",
  cwd: "/home/dev/app",
  serverId: "host-b",
};
const local: SessionReference = {
  sessionId: "sess-local-2",
  provider: "claude-code",
  title: "Plan the migration",
  cwd: "",
  serverId: "local",
};

function dragOf(references: SessionReference[]): FakeDataTransfer {
  const data = new FakeDataTransfer();
  writeSessionDrag(data, references);
  return data;
}

describe("session drag into the input bar", () => {
  test("a dropped session becomes the chip the agent resolves by id and host", () => {
    const references = readSessionDrag(dragOf([remote]));
    const insertion = sessionDropInsertion("Compare with ", 13, references)!;
    const text = "Compare with " + insertion.insert;

    // The composer sends what it tracks from the text: the same reference the
    // picker would have inserted, so the agent is told to read_session it.
    expect(extractTrackedReferences(text).sessionRefs).toEqual([remote]);
    // And a client opens the chip on the session's own host.
    const [chip] = parseReferenceTokens(text);
    expect(chip.token.kind).toBe("session");
    const href = text.slice(chip.from, chip.to).match(/\((session:\/\/[^)]+)\)/)![1];
    expect(parseSessionHref(href)).toMatchObject({ sessionId: "sess-remote-1", serverId: "host-b" });
  });

  test("several selected sessions add one chip each", () => {
    const references = readSessionDrag(dragOf([remote, local]));
    const insertion = sessionDropInsertion("", 0, references)!;
    expect(extractTrackedReferences(insertion.insert).sessionRefs).toEqual([remote, local]);
  });

  test("other apps get a session link and markdown, never a local file", () => {
    const data = dragOf([remote]);
    expect(data.effectAllowed).toBe("copyLink");
    expect(parseSessionHref(data.getData("text/uri-list"))?.sessionId).toBe("sess-remote-1");
    expect(data.getData("text/plain")).toStartWith("[Fix \\[flaky\\] login test](session://ref?");
  });

  test("a drop keeps chips whole and separated from the words around them", () => {
    const existing = `See ${"[Old](session://ref?sessionId=old&provider=codex&cwd=)"} now`;
    // A drop inside the existing chip's source lands after the chip.
    const inside = sessionDropInsertion(existing, 8, [local])!;
    expect(inside.from).toBe(existing.indexOf(" now"));
    // A drop against a word gets a space before it, and always one after.
    const afterWord = sessionDropInsertion("hello", 5, [local])!;
    expect(afterWord.insert.startsWith(" [Plan the migration]")).toBe(true);
    expect(afterWord.insert.endsWith(") ")).toBe(true);
    const text = "hello" + afterWord.insert;
    expect(extractTrackedReferences(text).sessionRefs).toHaveLength(1);
  });

  test("foreign and malformed drops are ignored", () => {
    // A file drop carries no session type; the composer leaves it to the attachment handler.
    const files = new FakeDataTransfer();
    files.setData("Files", "");
    files.setData("text/plain", "notes.md");
    expect(carriesSessionDrag(files)).toBe(false);
    expect(readSessionDrag(files)).toEqual([]);
    expect(sessionDropInsertion("hi", 2, readSessionDrag(files))).toBeNull();

    const broken = new FakeDataTransfer();
    broken.setData(SESSION_DRAG_TYPE, "{not json");
    expect(readSessionDrag(broken)).toEqual([]);

    const unknownProvider = new FakeDataTransfer();
    unknownProvider.setData(
      SESSION_DRAG_TYPE,
      JSON.stringify([{ sessionId: "x", provider: "gpt", title: "t", cwd: "" }, { ...local, sessionId: " " }, local]),
    );
    expect(readSessionDrag(unknownProvider)).toEqual([local]);
  });
});
