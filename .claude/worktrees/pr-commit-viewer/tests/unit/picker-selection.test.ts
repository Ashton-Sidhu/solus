/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { modelPickerNavigationTarget } from "../../src/renderer/components/pickers/lib/picker-selection";

describe("model picker keyboard navigation", () => {
  test("vertical movement stays in its visual column", () => {
    expect(
      modelPickerNavigationTarget({
        key: "ArrowDown",
        column: "model",
        index: 2,
        columnLength: 4,
        oppositeColumnLength: 5,
        preferredOppositeIndex: 1,
      }),
    ).toEqual({ column: "model", index: 3 });

    expect(
      modelPickerNavigationTarget({
        key: "ArrowDown",
        column: "model",
        index: 3,
        columnLength: 4,
        oppositeColumnLength: 5,
        preferredOppositeIndex: 1,
      }),
    ).toEqual({ column: "model", index: 3 });
  });

  test("right reaches the preferred reasoning level without traversing every model", () => {
    expect(
      modelPickerNavigationTarget({
        key: "ArrowRight",
        column: "model",
        index: 2,
        columnLength: 4,
        oppositeColumnLength: 5,
        preferredOppositeIndex: 3,
      }),
    ).toEqual({ column: "reasoning", index: 3 });
  });

  test("left returns to the model whose reasoning is being previewed", () => {
    expect(
      modelPickerNavigationTarget({
        key: "ArrowLeft",
        column: "reasoning",
        index: 3,
        columnLength: 5,
        oppositeColumnLength: 4,
        preferredOppositeIndex: 2,
      }),
    ).toEqual({ column: "model", index: 2 });
  });

  test("right remains available to open the Agent submenu", () => {
    expect(
      modelPickerNavigationTarget({
        key: "ArrowRight",
        column: "reasoning",
        index: 4,
        columnLength: 5,
        oppositeColumnLength: 4,
        preferredOppositeIndex: 2,
      }),
    ).toBeNull();
  });
});
