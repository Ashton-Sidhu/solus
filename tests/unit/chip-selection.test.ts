import { describe, expect, test } from "bun:test";
import { anchorEdge, focusEdge } from "../../packages/workspace-ui/src/lib/chip-selection";

// A chip copies as its whole link (`[foo.ts](src/foo.ts)`). A selection end
// that stayed inside it copied half a link, so every end moves to an edge.
describe("chip selection edges", () => {
  test("a selection that starts on a chip keeps the whole chip", () => {
    // Dragging right from a chip: the anchor goes before it, so it is copied.
    expect(anchorEdge(1)).toBe("before");
    // Dragging left from a chip: the anchor goes after it.
    expect(anchorEdge(-1)).toBe("after");
    // Still on the chip itself: the chip from its start.
    expect(anchorEdge(0)).toBe("before");
  });

  test("a pointer that reaches a chip takes the whole chip in", () => {
    expect(focusEdge(-1, -1, true)).toBe("after");
    expect(focusEdge(1, 1, true)).toBe("before");
    // The pointer is still over the chip after the focus moved past it. The
    // focus must stay where it is, or the edge would flip on every move.
    expect(focusEdge(-1, 1, true)).toBe("after");
  });

  test("a key steps over a chip, so the keyboard can grow and shrink past it", () => {
    // Growing right into a chip takes it.
    expect(focusEdge(-1, -1, false)).toBe("after");
    // Shrinking left back into it leaves it out, though the anchor is before
    // it. Taking it again would leave the focus stuck after the chip.
    expect(focusEdge(-1, 1, false)).toBe("before");
    expect(focusEdge(1, -1, false)).toBe("after");
  });
});
