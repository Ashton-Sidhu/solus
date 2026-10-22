// T3 #22128: when Android replaces the activity, the new React root mounts its
// dialog host before the old root unmounts. The old host's cleanup must not
// clear the new host's presenter, or every later dialog does nothing until the
// app restarts. This drives the real ConfirmDialogHost through React DOM with
// two roots; it is not proof of an activity replacement on a device.
import { afterEach, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import type { ReactNode } from "react";

// react-dom carries its own React; the component under test must share it.
const requireFromReactDom = createRequire(createRequire(import.meta.url).resolve("react-dom/package.json"));
const React = requireFromReactDom("react") as typeof import("react");
mock.module("react", () => React);
const { createElement } = React;

const Slot = (props: { readonly children?: ReactNode }) => createElement("div", null, props.children);
mock.module("react-native", () => ({
  Platform: { OS: "android" },
  Modal: Slot,
  Pressable: Slot,
  TextInput: () => null,
  View: Slot,
}));
mock.module("../../apps/mobile/src/components/AppText", () => ({ AppText: Slot }));
mock.module("../../apps/mobile/src/components/MaterialConfirmDialog", () => ({
  MaterialConfirmDialog: (props: { readonly request: { readonly title: string } }) =>
    createElement("p", null, props.request.title),
}));

const { ConfirmDialogHost, showTextInputDialog } = await import(
  "../../apps/mobile/src/components/ConfirmDialogHost"
);

const dom = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = requireFromReactDom("react-dom/client") as typeof import("react-dom/client");
const act = React.act;

const roots: ReturnType<typeof createRoot>[] = [];

async function mountHost() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(createElement(ConfirmDialogHost)));
  return { root, container };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

test("keeps presenting dialogs after an older root's host unmounts", async () => {
  const previous = await mountHost();
  const current = await mountHost();
  roots.splice(roots.indexOf(previous.root), 1);
  await act(async () => previous.root.unmount());

  await act(async () =>
    showTextInputDialog({ title: "Rename thread", initialValue: "", confirmText: "Save", onConfirm: () => undefined }),
  );

  expect(current.container.textContent).toContain("Rename thread");
});
