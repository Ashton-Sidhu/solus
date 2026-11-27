import { expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/community/datetime-picker", () => ({ DateTimePicker: () => null }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, Pressable: () => null }));
vi.mock("../../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./ScheduledTaskFields", () => ({ SelectRow: () => null }));

import { formatTime } from "./ScheduledTaskTimeFields";

it("formats the stored wall time even on the spring DST change", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-03-08T12:00:00Z"));
    const expected = new Date("2000-01-01T02:30:00Z").toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
    expect(formatTime("02:30")).toBe(expected);
  } finally {
    vi.useRealTimers();
  }
});
