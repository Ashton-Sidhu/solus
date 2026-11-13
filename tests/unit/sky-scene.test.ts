import { describe, expect, test } from "bun:test";
import { chosenSkyScene, isDarkSkyScene, skySceneAt } from "@solus/workspace-ui/lib/sky-scene";

const at = (hour: number, minute = 0) => new Date(2026, 10, 11, hour, minute);

describe("sky scene by time of day", () => {
  // WHY: the sidebar's sky and the new-tab home's mark both read this, and the
  // hours are a documented product rule (docs/plans/sidebar-places-and-sky.md).
  test("each scene starts on its documented hour and holds until the next", () => {
    expect(skySceneAt(at(5))).toBe("dawn");
    expect(skySceneAt(at(8, 59))).toBe("dawn");
    expect(skySceneAt(at(9))).toBe("day");
    expect(skySceneAt(at(16, 59))).toBe("day");
    expect(skySceneAt(at(17))).toBe("dusk");
    expect(skySceneAt(at(20, 59))).toBe("dusk");
    expect(skySceneAt(at(21))).toBe("night");
  });

  // WHY: night has no start hour after midnight, so a scan that only looks for
  // "the last scene that started today" would leave the small hours without one.
  test("night runs past midnight until dawn", () => {
    expect(skySceneAt(at(23, 59))).toBe("night");
    expect(skySceneAt(at(0))).toBe("night");
    expect(skySceneAt(at(4, 59))).toBe("night");
  });

  // WHY: Settings lets a person keep one scene. A kept scene must not move with
  // the clock, and `auto` must be the clock's scene and nothing else, or the
  // sidebar and the new-tab home would disagree with the setting.
  test("a kept scene ignores the clock, and auto follows it", () => {
    expect(chosenSkyScene("dusk", at(10))).toBe("dusk");
    expect(chosenSkyScene("dawn", at(23))).toBe("dawn");
    expect(chosenSkyScene("auto", at(10))).toBe("day");
    expect(chosenSkyScene("auto", at(23))).toBe("night");
  });

  // WHY: dusk and night are opaque dark pictures in the light theme too. The
  // title bar's controls turn light on exactly these scenes; on dawn and day
  // they must keep the theme's own colours or they vanish on a pale wash.
  test("only dusk and night put light controls on the title bar", () => {
    expect(isDarkSkyScene("dusk")).toBe(true);
    expect(isDarkSkyScene("night")).toBe(true);
    expect(isDarkSkyScene("dawn")).toBe(false);
    expect(isDarkSkyScene("day")).toBe(false);
  });
});
