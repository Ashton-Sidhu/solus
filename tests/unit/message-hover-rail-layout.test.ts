import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/conversation/MessageHoverRail.svelte",
  ),
  "utf8",
);
const typeScaleSource = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/index.css",
  ),
  "utf8",
);

describe("the assistant message rail", () => {
  test("uses the responsive conversation gutter rung for timestamps", () => {
    // Gutter timestamps stay below the persistent workspace rails: 12px on a
    // large display and 10px on a precise-pointer laptop.
    expect(source).toContain(
      '<span class="hover-rail-time text-conversation-gutter" {title}>{label}</span>',
    );
    expect(source).not.toContain("font-size: var(--text-xs)");
    expect(typeScaleSource).toContain("--text-conversation-gutter: 0.75rem;");
    expect(typeScaleSource).toMatch(
      /html\.is-laptop-display\s*\{[^}]*--text-conversation-gutter:\s*0\.625rem;/s,
    );
  });

  test("aligns the copy control with the first line without moving the user rail", () => {
    // The timestamp must not participate in the assistant rail's layout. If it
    // does, the copy control drops below the first line again. The right-side
    // user rail deliberately keeps the shared bottom alignment.
    expect(source).toContain('class:is-first-line={side === "left"}');
    expect(source).toMatch(
      /\.hover-rail\.is-first-line\s*\{[^}]*top:\s*0\.6875rem;[^}]*bottom:\s*auto;[^}]*gap:\s*0;/s,
    );
    expect(source).toMatch(
      /\.hover-rail\.is-first-line \.hover-rail-time\s*\{[^}]*position:\s*absolute;/s,
    );
    expect(source).toMatch(
      /\.hover-rail\.is-right\s*\{[^}]*left:\s*100%;/s,
    );
  });
});
