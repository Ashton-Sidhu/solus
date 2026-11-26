import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";

import { useFirstLayoutItems } from "./first-layout-items";

function setup() {
  // SAFETY: React reads this test flag from the global object; nothing else reads or types it.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let shown: readonly string[] = [];
  function Probe(props: { readonly items: readonly string[]; readonly laidOut: boolean }) {
    const items = useFirstLayoutItems(props.items, props.laidOut);
    useLayoutEffect(() => {
      shown = items;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    render(items: readonly string[], laidOut: boolean) {
      act(() => root.render(<Probe items={items} laidOut={laidOut} />));
      return shown;
    },
  };
}

it("keeps the first rows while the list lays them out, then shows each change", () => {
  const list = setup();
  // No rows yet: the list follows its data.
  expect(list.render([], false)).toEqual([]);
  const saved = ["a", "b"];
  expect(list.render(saved, false)).toBe(saved);
  // A host answer during the first layout would start that layout again: it waits.
  expect(list.render(["b", "a", "c"], false)).toBe(saved);
  // The list laid out its rows: the newest data shows.
  const fresh = ["b", "a", "c"];
  expect(list.render(fresh, true)).toBe(fresh);
});
