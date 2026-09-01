import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A finger needs 44px. The composer's controls are drawn smaller than that on
 * purpose — a 44px disc would dominate the pill — so the hit area is stretched
 * instead, by the `tap-area` utility. These rules live in markup and CSS, so
 * they are asserted against the source.
 *
 * Each assertion below can only fail if the rule itself is broken: a control
 * drops its tap area, the utility stops expanding to 44px, the phone takes the
 * laptop's dense sizing, or two 44px areas are packed close enough to overlap
 * and steal each other's taps.
 */
const repo = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

const css = read("packages/workspace-ui/src/index.css");
const inputBar = read(
  "packages/workspace-ui/src/components/input/InputBar.svelte",
);
const recordingControls = read(
  "packages/workspace-ui/src/components/input/RecordingControls.svelte",
);
const mobileActions = read(
  "apps/client/src/components/MobileComposerActions.svelte",
);

describe("the tap-area utility", () => {
  const utility = css.slice(
    css.indexOf("@utility tap-area"),
    css.indexOf("@utility menu-heading"),
  );

  it("is never applied without the coarse-pointer variant", () => {
    // The hand decides this, not the window: a mouse must not get an invisible
    // 44px box over its 30px control, where it would cover the neighbour the
    // tighter mouse gap leaves 4px away. Wrapping the utility in a `@media`
    // inside `@utility` compiled without it, so the guard lives at every call site.
    expect(utility).not.toContain("@media");
    for (const source of [inputBar, recordingControls, mobileActions]) {
      expect(source).not.toMatch(/[^:]\btap-area\b/);
    }
  });

  it("reaches 44px without ever shrinking a control that is already bigger", () => {
    expect(utility).toContain("width: max(100%, 2.75rem)");
    expect(utility).toContain("height: max(100%, 2.75rem)");
  });

  it("stays out of flow, so no row grows and no neighbour moves", () => {
    expect(utility).toContain("position: absolute");
    expect(utility).not.toMatch(/\bpadding\s*:/);
    expect(utility).not.toMatch(/\bmargin\s*:/);
  });
});

describe("the composer's touch controls", () => {
  it("does not show the idle mic on mobile", () => {
    // Mobile keeps the scarce action row for send. RecordingControls still
    // renders an active recording state, so a user is never left without a way
    // to finish voice input that started before the surface changed.
    expect(inputBar).toContain("showMic={voiceModel.supported && !isTouch}");
  });

  it("gives send a tap target", () => {
    const sendClass = inputBar.slice(
      inputBar.indexOf('data-testid={stopsRun ? "stop-button" : "send-button"}'),
    );
    expect(sendClass.slice(0, 600)).toContain("pointer-coarse:tap-area");
  });

  it("gives the bar mic a tap target", () => {
    // Both states of the same slot: the idle mic and the stop that replaces it
    // while recording. A reverse state a thumb cannot hit is a trap.
    expect(recordingControls).toContain("rc-bar-mic pointer-coarse:tap-area");
    expect(recordingControls).toContain(
      "recording-stop--bar pointer-coarse:tap-area",
    );
  });

  it("gives the phone's + a tap target", () => {
    expect(mobileActions).toContain(
      "mobile-pill-plus pointer-coarse:tap-area",
    );
  });

  it("keeps the mic and send far enough apart that their tap areas do not overlap", () => {
    // Two 44px areas around 36px controls need 0.5rem between the painted
    // boxes. Below that the later sibling's pseudo-element covers the earlier
    // control and takes taps meant for it.
    const clusters = inputBar.match(/gap-1 pointer-coarse:gap-2/g) ?? [];
    expect(clusters).toHaveLength(2);
  });

  it("does not hand the phone the laptop display's dense mic", () => {
    // `is-laptop-display` reads the monitor, and a phone screen is narrow
    // enough to match it — so the 28px rung must be gated on a fine pointer.
    const laptopRung = recordingControls.slice(
      recordingControls.indexOf("width: 1.75rem;\n      height: 1.75rem;") - 400,
      recordingControls.indexOf("width: 1.75rem;\n      height: 1.75rem;"),
    );
    expect(laptopRung).toContain("@media (pointer: fine)");
    expect(recordingControls).toMatch(
      /@media \(pointer: coarse\)[\s\S]*?\.rc-bar-mic[\s\S]*?width: 2\.25rem/,
    );
  });
});
