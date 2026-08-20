import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dir, "../../", path), "utf8");
}

describe("voice field coverage", () => {
  test("active recording state renders when the idle mic is hidden", () => {
    const controls = source(
      "packages/workspace-ui/src/components/input/RecordingControls.svelte",
    );
    const barRecording = controls.indexOf("{#if state === 'recording'}");
    const hiddenBarIdle = controls.indexOf("{:else if showMic}", barRecording);

    expect(barRecording).toBeGreaterThan(-1);
    expect(hiddenBarIdle).toBeGreaterThan(barRecording);
  });

  test("listening uses one finish control and keeps cancel on Escape", () => {
    const controls = source(
      "packages/workspace-ui/src/components/input/RecordingControls.svelte",
    );

    expect(controls).toContain('aria-label="Finish listening and transcribe"');
    expect(controls).toContain(
      '<MicrophoneIcon size={13} class="recording-mic-pulse" />',
    );
    expect(controls).toContain("background: transparent;");
    expect(controls).toContain(
      "border: 0.0625rem solid var(--solus-accent-border-medium);",
    );
    expect(controls).not.toContain("recording-stop__halo");
    expect(controls).not.toContain("var(--solus-accent) 42%");
    expect(controls).toContain(":global(.recording-mic-pulse)");
    expect(controls).toContain("event.key !== 'Escape'");
    expect(controls).toContain("onCancel()");
    expect(controls).not.toContain('aria-label="Cancel recording"');
    expect(controls).not.toContain("onclick={onCancel}");
  });

  test("shared prose editors separate voice support from idle mic visibility", () => {
    for (const path of [
      "packages/workspace-ui/src/components/ui/plain-text-editor/plain-text-editor.svelte",
      "packages/workspace-ui/src/components/editor/DocumentEditor.svelte",
    ]) {
      const editor = source(path);
      expect(editor).toContain("const dictationOn = $derived(dictation ?? mic)");
      expect(editor).toContain("{#if dictationOn");
      expect(editor).toContain("showMic={mic}");
    }
  });

  test("document and plan editors keep voice input in persistent chrome", () => {
    const documentShell = source(
      "packages/workspace-ui/src/components/document-shell/DocumentShell.svelte",
    );
    const editorCall = documentShell.slice(
      documentShell.indexOf("<DocumentEditor"),
      documentShell.indexOf("/>", documentShell.indexOf("<DocumentEditor")),
    );

    // WHY: DocumentShell owns both durable documents and plans. A control inside
    // the scrolling editor disappears in long documents, so the persistent shell
    // chrome owns the control and follows the editor's focus for shortcut routing.
    expect(documentShell).toContain("{#snippet voiceControl()}");
    expect(documentShell).toContain("<EditorVoiceControl");
    expect(documentShell).toContain("editorRef?.insertTranscript(transcript)");
    expect(documentShell.match(/\{@render voiceControl\(\)\}/g)).toHaveLength(2);
    expect(editorCall).toContain("onFocus={() => (editorFocused = true)}");
    expect(editorCall).toContain("onBlur={() => (editorFocused = false)}");
    expect(editorCall).not.toContain("dictation");
  });

  test("new shared and native text fields get focused dictation by default", () => {
    const input = source(
      "packages/workspace-ui/src/components/ui/input/input.svelte",
    );
    const textarea = source(
      "packages/workspace-ui/src/components/ui/textarea/textarea.svelte",
    );
    const app = source("packages/workspace-ui/src/App.svelte");
    const dictation = source("packages/workspace-ui/src/lib/dictation.svelte.ts");

    expect(input).toContain(
      'dictation ?? (type === undefined || ["text", "search", "url", "email"].includes(type))',
    );
    expect(textarea).toContain("dictation = true");
    expect(app).toContain('document.addEventListener("focusin", handleFocusIn)');
    expect(app).toContain('document.addEventListener("focusout", handleFocusOut)');
    expect(app).toContain('[data-slot="input-wrap"], [data-slot="textarea-wrap"]');
    expect(app).toContain("target.dataset.solusVoiceState = state");
    expect(dictation).toContain("el.dataset.dictation === 'false'");
  });

  test("the automation description bar exposes visible voice input", () => {
    const launchpad = source(
      "packages/workspace-ui/src/components/automations/AutomationLaunchpad.svelte",
    );
    const descriptionLabel = launchpad.indexOf('aria-label="Describe the automation"');
    const descriptionField = launchpad.slice(
      launchpad.lastIndexOf("<Input", descriptionLabel),
      descriptionLabel + 40,
    );

    // WHY: this is an action-oriented prompt, so hidden shortcut-only dictation
    // makes the capability undiscoverable and can leave the native field outside
    // the shared field ownership path.
    expect(descriptionField).toContain("mic");
  });

  test("mic and action pairs keep task-page spacing and responsive sizes", () => {
    const controls = source(
      "packages/workspace-ui/src/components/input/RecordingControls.svelte",
    );
    const taskComposer = source(
      "packages/workspace-ui/src/components/tasks/task-page/TaskCommentComposer.svelte",
    );
    const prComposer = source(
      "packages/workspace-ui/src/components/pr-review/ActivityFeed.svelte",
    );
    const insights = source(
      "packages/workspace-ui/src/components/insights/QueryConsole.svelte",
    );
    const automation = source(
      "packages/workspace-ui/src/components/automations/AutomationLaunchpad.svelte",
    );
    const inputBar = source(
      "packages/workspace-ui/src/components/input/InputBar.svelte",
    );
    const promptComposer = source(
      "packages/workspace-ui/src/components/ui/prompt-composer/prompt-composer.svelte",
    );

    // WHY: the mic is a separate action, not part of the submit button. The
    // task composer establishes a 4px gap, while desktop and laptop controls
    // use distinct sizes so neither surface looks crowded or undersized.
    expect(taskComposer).toContain("items-center gap-1 rounded-2xl");
    expect(prComposer).toContain("items-center gap-1 rounded-2xl");
    expect(insights).toContain("flex min-w-0 flex-1 items-center gap-1");
    expect(automation).toContain("flex min-w-0 flex-1 items-center gap-1");
    expect(inputBar).toContain("items-center gap-1");
    expect(promptComposer).toContain("items-center gap-1");
    expect(controls).toContain(":global(html.is-laptop-display) .rc-bar-mic");
    expect(controls).toContain(":global(html.is-laptop-display) .rc-mic");
    expect(insights).toContain("[.is-laptop-display_&]:size-6.5");
  });

  test("the global shortcut targets only the focused registered field", () => {
    const app = source("packages/workspace-ui/src/App.svelte");
    const dictation = source("packages/workspace-ui/src/lib/dictation.svelte.ts");
    expect(app).toMatch(
      /if \(dictation\.toggleFocusedRecorder\(document\.activeElement\)\) \{\s*[^}]*e\.stopImmediatePropagation\(\)/,
    );
    expect(dictation).toContain("this.focusedTarget === activeElement");
    expect(dictation).toContain("this.messageOwner === this.focusedMessageOwner");
  });

  test("a transient editor blur does not cancel active recording", () => {
    const control = source(
      "packages/workspace-ui/src/components/input/EditorVoiceControl.svelte",
    );
    expect(control).toContain(
      'dictation.state === "recording" || dictation.state === "transcribing"',
    );
    expect(control).not.toContain(
      "return () => dictation.releaseMessageConsumer(voiceOwnerId)",
    );
  });

  test("transcripts insert at each editor's current selection", () => {
    const dictation = source("packages/workspace-ui/src/lib/dictation.svelte.ts");
    const plainEditor = source(
      "packages/workspace-ui/src/components/ui/plain-text-editor/plain-text-editor.svelte",
    );
    const richEditor = source(
      "packages/workspace-ui/src/components/editor/DocumentEditor.svelte",
    );
    const promptEditor = source(
      "packages/workspace-ui/src/components/ui/PromptEditor.svelte",
    );
    const inputBar = source(
      "packages/workspace-ui/src/components/input/InputBar.svelte",
    );

    // WHY: recording UI can temporarily move DOM focus away from the input.
    // The editor-owned selection must remain the insertion point instead of
    // silently moving every completed transcript to the end of the draft.
    expect(dictation).toContain("selectionStart = el.selectionStart");
    expect(dictation).toContain("el.value.slice(0, from)");
    expect(dictation).toContain("el.value.slice(to)");
    expect(plainEditor).toContain("const selection = view.state.selection.main");
    expect(plainEditor).toContain(
      "changes: { from: selection.from, to: selection.to, insert: insertion }",
    );
    expect(richEditor).toContain("const { doc, selection } = editorInstance.state");
    expect(richEditor).toContain(".focus()\n      .insertContent");
    expect(richEditor).not.toContain('.focus("end")');
    expect(promptEditor).toContain(
      "plainTextEditorEl?.insertTranscript(transcript)",
    );
    expect(inputBar).toContain("composerEl?.insertTranscript(text)");
  });
});
