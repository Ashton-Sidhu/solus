import { expect, it } from "vite-plus/test";
import type { TranscriptItem } from "@solus-mobile/features/conversation/lib/transcript-model";
import {
  artifactGroupCounts,
  artifactGroupView,
  artifactVersion,
  changeArtifactGroupView,
  createArtifactGrouping,
  pickArtifactRevision,
  selectedRevision,
  selectedTab,
} from "./artifact-groups";

const prompt = (id: string): TranscriptItem => ({
  kind: "user",
  id,
  text: "go",
  attachments: [],
  delivery: "sent",
  error: null,
});
const render = (id: string, workId: string | null, contentVersion?: number): TranscriptItem => ({
  kind: "artifact",
  id,
  workId,
  title: workId ?? "Page",
  html: "<p>" + id + "</p>",
  ...(contentVersion && { contentVersion }),
});
const reply = (id: string): TranscriptItem => ({ kind: "assistant", id, text: "done" });

function groupsOf(items: TranscriptItem[], grouping = createArtifactGrouping()) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return grouping(
    items.map((item) => item.id),
    (key) => byId.get(key),
  );
}

it("groups two different works of one turn at the place of the first, with the last written tab selected", () => {
  const groups = groupsOf([
    prompt("p"),
    render("a", "plan"),
    reply("between"),
    render("b", "mock"),
  ]);
  const group = groups.get("a")!;
  // Both members point at one group; the row between them is not a member.
  expect(groups.get("b")).toBe(group);
  expect(groups.has("between")).toBe(false);
  expect(group.id).toBe("a");
  expect(group.tabs.map((tab) => tab.workId)).toEqual(["plan", "mock"]);
  expect(group.defaultTab).toBe(1);
  expect(artifactGroupCounts(group)).toEqual({ artifacts: 2, updated: 0, created: 2 });
});

it("shows a work that one turn wrote several times as one tab at its newest revision", () => {
  const group = groupsOf([
    prompt("p"),
    render("a1", "plan"),
    render("b", "mock"),
    render("a2", "plan"),
    render("a3", "plan"),
  ]).get("a1")!;
  expect(group.tabs).toHaveLength(2);
  const plan = group.tabs[0]!;
  expect(plan.revisions).toEqual(["a1", "a2", "a3"]);
  expect(plan.turnRevision).toBe(2);
  // The agent wrote "plan" last, so its tab is selected.
  expect(group.defaultTab).toBe(0);
  expect(artifactVersion(plan, plan.turnRevision)).toEqual({ version: 3, total: 3 });
});

it("leaves a turn with one work as it was", () => {
  const groups = groupsOf([prompt("p"), render("a1", "plan"), render("a2", "plan"), render("x", null)]);
  expect(groups.size).toBe(0);
});

it("closes the group at a new prompt, so works of two turns do not form one group", () => {
  const groups = groupsOf([prompt("p1"), render("a", "plan"), prompt("p2"), render("b", "mock")]);
  expect(groups.size).toBe(0);
});

it("does not close the turn at a prompt that waits in the queue", () => {
  const queued: TranscriptItem = { ...prompt("q"), waitsForTurn: true, delivery: "queued" } as TranscriptItem;
  const groups = groupsOf([prompt("p"), render("a", "plan"), queued, render("b", "mock")]);
  expect(groups.get("a")?.tabs).toHaveLength(2);
});

it("numbers revisions by their saved content version and steps through every revision in the conversation", () => {
  const group = groupsOf([
    prompt("p1"),
    render("a1", "plan", 3),
    prompt("p2"),
    render("a2", "plan", 4),
    render("b", "mock"),
    prompt("p3"),
    render("a3", "plan"),
  ]).get("a2")!;
  const plan = group.tabs[0]!;
  expect(plan.revisions).toEqual(["a1", "a2", "a3"]);
  expect(plan.versions).toEqual([3, 4, 5]);
  expect(plan.turnRevision).toBe(1);
  expect(artifactVersion(plan, plan.turnRevision)).toEqual({ version: 4, total: 5 });
  // "plan" had a revision before this turn; "mock" did not.
  expect(artifactGroupCounts(group)).toEqual({ artifacts: 2, updated: 1, created: 1 });
});

it("counts a work as updated when its first revision in the conversation has a later saved version", () => {
  const group = groupsOf([prompt("p"), render("a", "plan", 2), render("b", "mock", 1)]).get("a")!;
  expect(artifactGroupCounts(group)).toEqual({ artifacts: 2, updated: 1, created: 1 });
});

it("keeps the group object while its members do not change, so the feed row is not built again", () => {
  const grouping = createArtifactGrouping();
  const items = [prompt("p"), render("a", "plan"), render("b", "mock")];
  const first = groupsOf(items, grouping).get("a");
  expect(groupsOf([...items, reply("r")], grouping).get("a")).toBe(first);
  const grown = groupsOf([...items, render("c", "plan")], grouping).get("a");
  expect(grown).not.toBe(first);
  expect(grown?.defaultTab).toBe(0);
});

it("keeps the selected tab, picked version, and fold state of a card outside the row", () => {
  const conversation = {};
  const group = groupsOf([prompt("p"), render("a1", "plan"), render("a2", "plan"), render("b", "mock")]).get("a1")!;
  const opened = artifactGroupView(conversation, group.id);
  expect(opened.folded).toBe(false);
  expect(selectedTab(group, opened)).toBe(1);
  changeArtifactGroupView(conversation, group.id, { workId: "plan", folded: true });
  pickArtifactRevision(conversation, group.id, "plan", "a1");
  // A row that mounts again reads the same choices.
  const remounted = artifactGroupView(conversation, group.id);
  expect(remounted.folded).toBe(true);
  expect(selectedTab(group, remounted)).toBe(0);
  expect(selectedRevision(group.tabs[0]!, remounted)).toBe(0);
  expect(selectedRevision(group.tabs[1]!, remounted)).toBe(0);
  // Another conversation has its own view.
  expect(artifactGroupView({}, group.id).folded).toBe(false);
});
