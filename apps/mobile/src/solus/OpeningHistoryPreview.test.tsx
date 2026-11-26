// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { resolveUserMessageGrouping } from "@t3tools/client-runtime/user-message";
import { OpeningHistoryPreview } from "./OpeningHistoryPreview";

vi.mock("react-native", () => ({
  StyleSheet: { absoluteFill: {} },
  View: ({ children, onLayout }: { children: ReactNode; onLayout?: () => void }) =>
    <div data-layout={onLayout ? "preview" : undefined} onClick={onLayout}>{children}</div>,
}));

it("paints the last row before the list starts measuring the page", () => {
  vi.useFakeTimers();
  const node = document.createElement("div");
  const root = createRoot(node);
  const rows = ["earlier", "latest"].map((id) => ({
    type: "conversation-card" as const, id, runId: null, createdAt: "", render: () => null,
    userMessageGrouping: resolveUserMessageGrouping(undefined, undefined, undefined),
  }));
  try {
    act(() => root.render(
      <OpeningHistoryPreview firstIndex={0} rows={rows} bottom={0} left={0} right={0}
        renderRow={({ item, index }) => <span key={item.id}>{index}-{item.id}</span>}>
        <span>Interactive list</span>
      </OpeningHistoryPreview>,
    ));
    act(() => { vi.advanceTimersByTime(100); });
    expect(node.textContent).toBe("1-latest");
    act(() => node.querySelector<HTMLElement>("[data-layout=preview]")!.click());
    act(() => { vi.advanceTimersByTime(100); });
    expect(node.textContent).toBe("Interactive list0-earlier1-latest");
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});
