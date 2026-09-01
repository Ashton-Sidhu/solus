import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * On a phone there is one `+` and it always means the Add-to-chat sheet.
 *
 * Two composers can be on screen over a session's life: the shell's dock once a
 * session exists, and a session draft's own bar before it does. The draft used
 * to render the desktop editor toolbar, whose `+` is `AddFilesButton` and opens
 * the OS file picker directly — so the same glyph meant two different things
 * depending on which composer you were in, and the sheet (with the review
 * surface, the model, the project, the git actions) was unreachable from a
 * draft at all.
 *
 * The rules below are what keeps that from coming back. Each can only fail if
 * the behaviour itself regressed: a composer stops sharing the phone's control
 * pair, or one of the sheets goes back to reading the active tab instead of the
 * composer that opened it — which on a draft is a different session entirely.
 */
const repo = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

const composerActions = read(
  "apps/client/src/components/MobileComposerActions.svelte",
);
const plusMenu = read("apps/client/src/components/MobilePlusMenu.svelte");
const sessionSheet = read("apps/client/src/components/MobileSessionSheet.svelte");
const mobileLayout = read("apps/client/src/components/WebMobileLayout.svelte");
const webLayout = read("apps/client/src/components/WebLayout.svelte");
const draftPane = read(
  "packages/workspace-ui/src/components/session-draft/SessionDraftPane.svelte",
);
const clientApp = read("apps/client/src/App.svelte");

describe("the phone's `+`", () => {
  it("opens the sheet, never the OS file picker", () => {
    // `AddFilesButton` is the desktop editor's `+` and calls `onAttachFile`,
    // which on the web client is `input.type = 'file'; input.click()`.
    expect(composerActions).toContain("mobileComposerMenu.open = true");
    expect(composerActions).not.toContain("onAttachFile");
  });

  it("is the same control in the dock and in a draft", () => {
    // Both composers render the shared pair. If either grows its own `+`
    // again, the two stop agreeing about what the glyph does.
    expect(mobileLayout).toContain("<MobileComposerActions");
    expect(webLayout).toContain("<MobileComposerActions");
    expect(mobileLayout).not.toContain('class="mobile-pill-plus');
  });

  it("reaches the shell's sheet from a draft, which the shell does not own", () => {
    // A draft is a routed surface inside the shell's content area, so it
    // cannot be handed a callback by the shell. Both sides share the flag.
    expect(composerActions).toContain(
      'from "../lib/mobile-composer-menu.svelte"',
    );
    expect(mobileLayout).toContain("open={mobileComposerMenu.open}");
  });
});

describe("a draft's composer", () => {
  it("takes the phone's controls in place of the desktop editor toolbar", () => {
    expect(draftPane).toContain("{@render composerActions(savedPromptsControl)}");
    expect(webLayout).toContain(
      "composerActions={isMobile ? draftComposerActions : undefined}",
    );
    // Desktop keeps the toolbar — the phone branch must be a replacement, not
    // a removal.
    expect(draftPane).toContain("<InputToolbar");
  });

  it("hands the sheets the draft's id, not the tab behind it", () => {
    expect(mobileLayout).toContain("sourceId={mobileDraft?.id ?? session.activeTabId}");
    expect(webLayout).toContain("sourceId={leadingDraftParams?.draftId}");
  });
});

describe("the sheets", () => {
  // `runFor`/`apiFor` resolve a started session's tab *or* a draft id, so a
  // source-addressed sheet needs no branch of its own. Reading `activeSession`
  // or `activeTabId` is what silently retargets it at the wrong composer.
  it("read and write through the composer that opened them", () => {
    for (const sheet of [plusMenu, sessionSheet]) {
      expect(sheet).toContain("session.runFor(composerSourceId)");
      expect(sheet.match(/session\.activeTabId/g) ?? []).toHaveLength(1);
      expect(sheet).not.toContain("session.activeSession");
      expect(sheet).not.toContain("statusBar.ctx;");
    }
  });

  it("say the review surface is unavailable on a draft rather than showing no changes", () => {
    // A review surface is addressed by a tab, which a draft has none of.
    // "None" would be a claim about the repository, and a different fact.
    expect(plusMenu).toContain("{#if !canShowDiffPanel}");
    expect(plusMenu).toContain("Unavailable");
    expect(mobileLayout).toContain("canShowDiffPanel={canShowDiffPanel && !mobileDraft}");
  });
});

describe("attaching a file from the sheet", () => {
  it("files it in the composer's own prompt", () => {
    // `inputFor` reaches a tab's prompt and falls back to the workspace input
    // for anything else, so a draft's files would vanish into that fallback.
    expect(clientApp).toContain("session.sessionDrafts.get(targetTabId)");
    expect(clientApp).toContain("draft.prompt.attachments.push(...files)");
    expect(clientApp).toContain("session.focusedSourceId");
    expect(plusMenu).toContain("onAttachFile(composerSourceId)");
  });

  it("resolves a drop the same way it resolves a pick", () => {
    // Two entry points, one target. The drop used to read `focusedChatTabId`,
    // which by definition names the session *behind* a draft, and then wrote
    // through `addAttachments` — the tab-only path the helper exists to avoid.
    expect(clientApp).toContain("attachmentTargetFor(undefined)");
    expect(clientApp).not.toContain("session.addAttachments(attachments, tabId)");
  });
});

const taskSheet = read("apps/client/src/components/MobileTaskSheet.svelte");

describe("asking for a project from a sheet", () => {
  // `solus:open-directory-picker` accepts `requesterId` — a tab id *or* a draft
  // id — precisely because the emitter often cannot tell which it holds.
  // Dispatched bare, the handler resolves no source at all and `setBaseDirectory`
  // opens a second draft at that project instead of pointing this composer at
  // it. On a phone, where the composer before Send is always a draft, that was
  // every project pick in the app.
  const bareDispatch = /new CustomEvent\(\s*"solus:open-directory-picker"\s*\)/;

  it("names the composer that asked, from every mobile surface", () => {
    for (const surface of [plusMenu, taskSheet]) {
      expect(surface).not.toMatch(bareDispatch);
      expect(surface).toContain("requesterId:");
    }
  });

  it("hands the plus menu's three project rows one addressed dispatch", () => {
    // Three rows reach the picker — two hero cards and a list row. They must
    // agree about which composer is asking, so they share one function.
    expect(plusMenu.match(/onclick=\{openProjectPicker\}/g) ?? []).toHaveLength(3);
    expect(plusMenu).toContain("requesterId: composerSourceId");
  });
});

describe("the composer keybindings", () => {
  it("aim at the focused composer, which may be a draft", () => {
    // `activeSession` names only a started conversation. With a draft pane
    // leading — the phone's normal state — model, mode and agent shortcuts read
    // and wrote the session behind it. `focusedSourceId` answers for both.
    expect(clientApp).toContain(
      "const composerSourceId = $derived(session.focusedSourceId ?? undefined)",
    );
    expect(clientApp).toContain(
      'session.setPermissionMode(next, composerSourceId, "keybinding")',
    );
    expect(clientApp).toContain('}, composerSourceId, "keybinding")');
    expect(clientApp).toContain(
      "session.switchActiveAgent(next.id, composerSourceId, via)",
    );
  });

  it("cycles the composer's own provider's models", () => {
    // `agent.activeMetadata` is the app-wide agent. A draft switched to Codex
    // would otherwise cycle Claude's list and be handed a model it cannot run.
    expect(clientApp).toContain(
      "agent.metadata[composerRun?.provider ?? settings.activeAgent]",
    );
    expect(clientApp).not.toContain("agent.activeMetadata?.models");
  });
});

describe("git actions from the plus menu", () => {
  it("are built with the PRs store the shared instance requires", () => {
    // `gitActionsFor` is memoized per source id and shared with the desktop
    // project panel. `pullRequests` is not optional: creating a pull request
    // hands it to the store so the sidebar and task row can name it before the
    // next refresh, and an undefined store throws right after the PR exists.
    expect(plusMenu).toContain(
      "gitActionsFor(composerSourceId, session, environmentStore, pullRequests.projects)",
    );
  });
});
