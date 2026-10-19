// The Android workspace keeps Chats and Pull Requests mounted after their
// first visit, so a return shows the list as it was left. A hidden list must
// not keep acting: its effects (search Back handler, header options, focus
// refresh, host reads) stop while it is hidden and run again when it shows.
// This drives the real WorkspaceTabPanes through React DOM's Activity; it is
// not proof of React Native's hiding on a device.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import type { ReactNode } from "react";

// react-dom carries its own React (19.2.8, beside the app's 19.3.0); the
// component under test must share the renderer's copy, so `react` is that copy.
const requireFromReactDom = createRequire(createRequire(import.meta.url).resolve("react-dom/package.json"));
const React = requireFromReactDom("react") as typeof import("react");
mock.module("react", () => React);
const { createElement, useEffect, useState } = React;

const platform = { OS: "android" };
mock.module("react-native", () => ({
  Platform: platform,
  View: (props: { readonly children?: ReactNode }) => createElement("section", null, props.children),
}));

const { WorkspaceTabPanes } = await import("../../apps/mobile/src/features/workspace/WorkspaceTabPanes");
type Tab = "chats" | "pullRequests";

const dom = new JSDOM("<!doctype html><div id=root></div>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = requireFromReactDom("react-dom/client") as typeof import("react-dom/client");
const act = React.act;

let events: string[] = [];
let root: ReturnType<typeof createRoot>;

/** A list that remembers when it was first mounted, in state, and records its effect's lifetime, as a refresh registration does. */
function List(props: { readonly tab: Tab }) {
  const [opened] = useState(() => `${props.tab}@${events.length}`);
  useEffect(() => {
    events.push(`start ${props.tab}`);
    return () => void events.push(`stop ${props.tab}`);
  }, [props.tab]);
  return createElement("p", { "data-tab": props.tab }, opened);
}

async function show(selected: Tab) {
  await act(async () => {
    root.render(createElement(WorkspaceTabPanes, { selected, renderTab: (tab: Tab) => createElement(List, { tab }) }));
  });
}

const pane = (tab: Tab) => document.querySelector(`[data-tab="${tab}"]`);
const hidden = (tab: Tab) => (pane(tab)?.parentElement as HTMLElement | null)?.style.display === "none";

beforeEach(() => {
  events = [];
  platform.OS = "android";
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("Android workspace tab panes", () => {
  test("mounts a tab on its first visit only", async () => {
    await show("chats");
    expect(pane("chats")).not.toBeNull();
    expect(pane("pullRequests")).toBeNull();
    expect(events).toEqual(["start chats"]);
  });

  test("a hidden tab keeps its state, stops its effects, and starts them again on return", async () => {
    await show("chats");
    const chatsOpened = pane("chats")?.textContent;
    await show("pullRequests");
    expect(events).toEqual(["start chats", "stop chats", "start pullRequests"]);
    expect(hidden("chats")).toBe(true);
    expect(hidden("pullRequests")).toBe(false);

    await show("chats");
    expect(events.slice(3)).toEqual(["stop pullRequests", "start chats"]);
    // The same list instance returns: its state was kept, not rebuilt.
    expect(pane("chats")?.textContent).toBe(chatsOpened);
    expect(hidden("chats")).toBe(false);
    expect(hidden("pullRequests")).toBe(true);
    expect(document.querySelectorAll("[data-tab]").length).toBe(2);
  });

  test("iOS renders only the selected tab: its native tab trees are retained instead", async () => {
    platform.OS = "ios";
    await show("chats");
    await show("pullRequests");
    expect(pane("chats")).toBeNull();
    expect(events).toEqual(["start chats", "stop chats", "start pullRequests"]);
  });
});
