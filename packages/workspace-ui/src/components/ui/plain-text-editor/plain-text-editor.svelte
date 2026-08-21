<script lang="ts">
  import { untrack } from "svelte";
  import {
    Compartment,
    EditorState,
    Prec,
    type Extension,
  } from "@codemirror/state";
  import {
    defaultKeymap,
    history,
    historyKeymap,
  } from "@codemirror/commands";
  import {
    HighlightStyle,
    syntaxHighlighting,
  } from "@codemirror/language";
  import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
  import { tags } from "@lezer/highlight";
  import {
    EditorView,
    keymap,
    placeholder as placeholderExtension,
  } from "@codemirror/view";
  import type {
    PlanReference,
    SessionReference,
    WorkReference,
  } from "@solus/contracts/types";
  import type { ReferenceToken } from "../../editor/reference-tokens";
  import {
    createReferenceDecorations,
    extractTrackedReferences,
    insertReferenceAtCursor,
    replaceTriggerAtCursor,
    type ReferenceDecorationCallbacks,
    type ReferenceDecorationConfig,
  } from "./lib/reference-decorations";
  import EditorVoiceControl from "../../input/EditorVoiceControl.svelte";
  import { dictationInsertion } from "../../input/lib/dictation-text";
  import { markdownComposerKeymap } from "./lib/markdown-keymap";
import { ghostCompletion, showGhost } from "./lib/ghost-completion";

  interface Props extends ReferenceDecorationCallbacks {
    value: string;
    onValueChange: (value: string) => void;
    onInput?: () => void;
    onEmptyChange?: (empty: boolean) => void;
    onKeyDown?: (event: KeyboardEvent) => void;
    onPaste?: (event: ClipboardEvent) => void;
    onDrop?: (event: DragEvent) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    placeholder?: string;
    ariaLabel?: string;
    hidePlaceholderOnFocus?: boolean;
    disabled?: boolean;
    /** Show the shared push-to-talk recorder beside this prose editor. */
    mic?: boolean;
    /** Enable the voice shortcut even when the idle mic is hidden. */
    dictation?: boolean;
    /** Keep the recorder over the field, or give it its own place beside it. */
    micPlacement?: "inside" | "beside";
    maxHeight?: number;
    enterInsertsNewline?: boolean;
    referenceChips?: boolean;
    slashCommands?: string[];
    class?: string;
    style?: string;
  }

  let {
    value,
    onValueChange,
    onInput,
    onEmptyChange,
    onKeyDown,
    onPaste,
    onDrop,
    onFocus,
    onBlur,
    onPlanRefClick,
    onWorkRefClick,
    onPrRefClick,
    onFileRefClick,
    placeholder = "",
    ariaLabel,
    hidePlaceholderOnFocus = false,
    disabled = false,
    mic = false,
    dictation,
    micPlacement = "inside",
    maxHeight = 140,
    enterInsertsNewline = false,
    referenceChips = false,
    slashCommands = [],
    class: klass = "",
    style = "",
  }: Props = $props();

  const dictationOn = $derived(dictation ?? mic);

  let wrapper: HTMLDivElement | null = $state(null);
  let editorHost: HTMLDivElement | null = $state(null);
  let view: EditorView | null = $state.raw(null);
  let lastLocalValue: string | null = null;
  let isApplyingValue = false;
  // CodeMirror can synchronously blur while Svelte is reconciling a template.
  // Reconfigure the placeholder synchronously, but defer the reactive focus
  // notification until Svelte has finished that reconciliation.
  let isFocused = $state(false);
  const editableCompartment = new Compartment();
  const placeholderCompartment = new Compartment();
  const attributesCompartment = new Compartment();
  const keymapCompartment = new Compartment();
  const referenceCompartment = new Compartment();

  const referenceConfig = $derived<ReferenceDecorationConfig>({
    slashCommands,
    onPlanRefClick,
    onWorkRefClick,
    onPrRefClick,
    onFileRefClick,
  });
  const references = createReferenceDecorations(() => referenceConfig);

  // The composer is prose, not a code editor. Keep Markdown's typographic
  // emphasis without defaultHighlightStyle's syntax palette — in particular,
  // that palette paints URL tokens purple (#219).
  const composerHighlightStyle = HighlightStyle.define([
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "500" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
  ]);

  const editorTheme = EditorView.theme({
    "&": {
      width: "100%",
      color: "var(--solus-text-primary)",
      backgroundColor: "transparent",
      fontFamily: "inherit",
      fontSize:
        "var(--plain-editor-font-size, var(--text-body))",
      fontWeight: "var(--solus-font-weight-body, 400)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      maxHeight: "var(--plain-editor-max-height, 8.75rem)",
      overflowY: "auto",
      fontFamily: "inherit",
      // Most compact editors use the font's own leading. Reading surfaces can
      // opt into a looser measure without changing the shared editor geometry.
      lineHeight: "var(--plain-editor-line-height, normal)",
      scrollbarWidth: "auto",
    },
    // index.css draws the thumb (and reveals it only while the composer is
    // scrolling); the track margin is the one thing local to this surface — it
    // holds the pill well inside the composer's padded well, so it never runs
    // to the card's rounded corners.
    ".cm-scroller::-webkit-scrollbar-track": {
      background: "transparent",
      margin: "0.625rem 0",
    },
    ".cm-content": {
      // The floor for an empty editor. A host that wants a taller resting well
      // raises it; the composers instead size their well from symmetric
      // padding, so the first line sits centred in it.
      minHeight: "var(--plain-editor-min-height, 1.25rem)",
      // The room the tightened leading gives up comes back here, so a one-line
      // composer stands the height it always has.
      padding: "var(--plain-editor-padding, 0.9375rem 0 0.9375rem 0.25rem)",
      paddingRight: mic && micPlacement === "inside" ? "4.25rem" : undefined,
      // The caret is text, so it takes the text's colour — never the accent.
      caretColor: "currentColor",
      wordBreak: "break-word",
      whiteSpace: "pre-wrap",
    },
    ".cm-line": { padding: "0" },
    // Colour only: inheriting the line's own metrics is what lands the
    // placeholder's first character exactly where the first typed one goes.
    //
    // `inline` overrides CodeMirror's own `inline-block`, which is load-bearing
    // for the caret. An inline-block that wraps is one box as tall as all its
    // lines, and the caret on an empty document takes the whole line box — so a
    // placeholder long enough to wrap drew a caret spanning every wrapped line
    // and read as several stacked cursors. Inline text wraps into one line box
    // per line, so the caret stands exactly one line tall wherever the hint runs.
    ".cm-placeholder": { color: "var(--solus-placeholder)", display: "inline" },
  });

  function isCompositionEvent(event: KeyboardEvent): boolean {
    return event.isComposing || event.keyCode === 229;
  }

  function setFocused(focused: boolean) {
    queueMicrotask(() => {
      isFocused = focused;
    });
    if (!view || !hidePlaceholderOnFocus) return;
    view.dispatch({
      effects: placeholderCompartment.reconfigure(
        placeholderExtension(focused ? "" : placeholder),
      ),
    });
  }

  function editorExtensions(): Extension[] {
    return [
      history(),
      EditorView.lineWrapping,
      markdown({
        base: markdownLanguage,
        addKeymap: false,
        completeHTMLTags: false,
      }),
      syntaxHighlighting(composerHighlightStyle),
      editorTheme,
      editableCompartment.of(EditorView.editable.of(!disabled)),
      placeholderCompartment.of(
        placeholderExtension(
          hidePlaceholderOnFocus && isFocused ? "" : placeholder,
        ),
      ),
      keymapCompartment.of([
        Prec.highest(
          keymap.of(
            markdownComposerKeymap(
              enterInsertsNewline,
              () => referenceConfig,
            ),
          ),
        ),
        keymap.of([...historyKeymap, ...defaultKeymap]),
      ]),
      referenceCompartment.of(referenceChips ? references.extension : []),
      ghostCompletion,
      attributesCompartment.of(
        EditorView.contentAttributes.of({
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": ariaLabel || placeholder || "Message input",
          autocorrect: "off",
          autocapitalize: "off",
          autocomplete: "off",
          spellcheck: "false",
        }),
      ),
      Prec.highest(
        EditorView.domEventHandlers({
          keydown(event) {
            if (isCompositionEvent(event)) return false;
            onKeyDown?.(event);
            return event.defaultPrevented;
          },
          paste(event) {
            onPaste?.(event);
            return event.defaultPrevented;
          },
          drop(event) {
            onDrop?.(event);
            return event.defaultPrevented;
          },
          focus() {
            setFocused(true);
            queueMicrotask(() => onFocus?.());
            return false;
          },
          blur() {
            setFocused(false);
            queueMicrotask(() => onBlur?.());
            return false;
          },
        }),
      ),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const nextValue = update.state.doc.toString();
        if (isApplyingValue) return;
        lastLocalValue = nextValue;
        untrack(() => {
          onInput?.();
          onEmptyChange?.(nextValue.length === 0);
          onValueChange(nextValue);
        });
      }),
    ];
  }

  // The view is built for its host element and depends on nothing else — every
  // prop below reaches the live editor through a compartment. Untracking each
  // argument is not enough: `EditorState.create` runs the reference state field,
  // which reads `referenceConfig`, so the view became a dependent of the
  // slash-command list. A draft loads its commands after mounting, and that
  // arrival rebuilt the editor under the user's caret.
  $effect(() => {
    const host = editorHost;
    if (!host) return;
    return untrack(() => {
      const initialValue = value;
      const editorView = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: initialValue,
          selection: { anchor: initialValue.length },
          extensions: editorExtensions(),
        }),
      });
      view = editorView;
      onEmptyChange?.(initialValue.length === 0);
      return () => {
        editorView.destroy();
        if (view === editorView) view = null;
      };
    });
  });

  $effect(() => {
    const externalValue = value;
    if (!view) return;
    if (externalValue === lastLocalValue) {
      lastLocalValue = null;
      return;
    }
    const currentValue = view.state.doc.toString();
    if (currentValue !== externalValue) {
      isApplyingValue = true;
      try {
        view.dispatch({
          changes: { from: 0, to: currentValue.length, insert: externalValue },
          selection: { anchor: externalValue.length },
        });
      } finally {
        isApplyingValue = false;
      }
      untrack(() => onEmptyChange?.(externalValue.length === 0));
    }
    lastLocalValue = null;
  });

  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.reconfigure(
        EditorView.editable.of(!disabled),
      ),
    });
  });

  $effect(() => {
    if (!view) return;
    const shownPlaceholder =
      hidePlaceholderOnFocus && isFocused ? "" : placeholder;
    view.dispatch({
      effects: [
        placeholderCompartment.reconfigure(
          placeholderExtension(shownPlaceholder),
        ),
        attributesCompartment.reconfigure(
          EditorView.contentAttributes.of({
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": ariaLabel || placeholder || "Message input",
            autocorrect: "off",
            autocapitalize: "off",
            autocomplete: "off",
            spellcheck: "false",
          }),
        ),
      ],
    });
  });

  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: keymapCompartment.reconfigure([
        Prec.highest(
          keymap.of(
            markdownComposerKeymap(
              enterInsertsNewline,
              () => referenceConfig,
            ),
          ),
        ),
        keymap.of([...historyKeymap, ...defaultKeymap]),
      ]),
    });
  });

  $effect(() => {
    void referenceConfig;
    if (!view) return;
    view.dispatch({
      effects: referenceCompartment.reconfigure(
        referenceChips ? references.extension : [],
      ),
    });
    // The compartment holds the same extension when only the config behind it
    // changed, so reconfiguring alone leaves the chips drawn from the old slash
    // commands. Ask the field to rebuild them.
    if (referenceChips) references.refresh(view);
  });

  function editorValue(): string {
    return view?.state.doc.toString() ?? value;
  }

  export function focus() {
    if (!view) return;
    view.focus();
    const end = view.state.doc.length;
    view.dispatch({ selection: { anchor: end }, scrollIntoView: true });
  }

  /** Restore DOM focus without changing the selection established by an
   * editor transaction, such as an autocomplete insertion in mid-sentence. */
  export function focusAtSelection() {
    view?.focus();
  }

  export function setValueAndCursor(
    text: string,
    autoFocus = true,
    _ensureTrailingParagraph = false,
  ) {
    if (!view) return;
    const current = view.state.doc.toString();
    lastLocalValue = null;
    isApplyingValue = true;
    try {
      if (current === text) {
        view.dispatch({
          selection: { anchor: text.length },
          scrollIntoView: autoFocus,
        });
      } else {
        view.dispatch({
          changes: { from: 0, to: current.length, insert: text },
          selection: { anchor: text.length },
          scrollIntoView: autoFocus,
        });
      }
    } finally {
      isApplyingValue = false;
    }
    onEmptyChange?.(text.length === 0);
    if (autoFocus) view.focus();
  }

  export function clearEditor() {
    setValueAndCursor("", false);
  }

  export function insertTextAtSelection(text: string) {
    if (!view) return;
    const selection = view.state.selection.main;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: { anchor: selection.from + text.length },
      scrollIntoView: true,
    });
    view.focus();
  }

  export function insertTranscript(transcript: string): void {
    if (!view) return;
    const documentText = view.state.doc.toString();
    const selection = view.state.selection.main;
    const insertion = dictationInsertion(
      transcript,
      documentText.slice(0, selection.from),
      documentText.slice(selection.to),
    );
    if (!insertion) return;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: insertion },
      selection: { anchor: selection.from + insertion.length },
      scrollIntoView: true,
    });
    view.focus();
  }

  export function removeFirstText(text: string) {
    if (!view || !text) return;
    const start = view.state.doc.toString().indexOf(text);
    if (start < 0) return;
    view.dispatch({ changes: { from: start, to: start + text.length } });
  }

  export function isCaretAtStart(): boolean {
    return view?.state.selection.main.head === 0;
  }

  /** Draw (or clear) the grey completion the autocomplete menu is offering. */
  export function setGhostCompletion(text: string) {
    if (view) showGhost(view, text);
  }

  export function isCaretAtLineEnd(): boolean {
    if (!view) return true;
    const head = view.state.selection.main.head;
    return head === view.state.doc.lineAt(head).to;
  }

  export function textBeforeCursor(): string {
    if (!view) return "";
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return view.state.doc.sliceString(line.from, head);
  }

  export function getCursorRect(): DOMRect | null {
    if (!view) return wrapper?.getBoundingClientRect() ?? null;
    const wrapperRect = wrapper?.getBoundingClientRect() ?? null;
    const cursor = view.coordsAtPos(view.state.selection.main.head);
    if (!wrapperRect || !cursor) return wrapperRect;
    return new DOMRect(
      wrapperRect.left,
      cursor.top,
      wrapperRect.width,
      cursor.bottom - cursor.top,
    );
  }

  export function replaceTrigger(
    pattern: RegExp,
    replacement: string,
  ): boolean {
    if (!view) return false;
    const result = replaceTriggerAtCursor(view, pattern, replacement);
    if (result.changed && replacement.startsWith("@"))
      references.revealFileBeforeCursor(view);
    return result.changed;
  }

  export function insertReference(
    token: ReferenceToken,
    pattern: RegExp,
  ): boolean {
    return view ? insertReferenceAtCursor(view, token, pattern) : false;
  }

  export function unwrapFileReferenceBeforeCursor(): boolean {
    return view ? references.revealFileBeforeCursor(view) : false;
  }

  export function extractReferences(): {
    planRefs: PlanReference[];
    workRefs: WorkReference[];
    sessionRefs: SessionReference[];
  } {
    return extractTrackedReferences(editorValue());
  }
</script>

<div
  bind:this={wrapper}
  data-testid="message-input"
  class="relative w-full min-w-0 {mic && micPlacement === 'beside' ? 'flex items-center gap-1' : ''} {klass}"
  style="--plain-editor-max-height:{maxHeight}px; {style}"
>
  <div bind:this={editorHost} class="min-w-0 flex-1"></div>
  {#if dictationOn}
    <div
      class={micPlacement === "beside"
        ? "flex shrink-0 items-center"
        : "absolute top-1 right-0 z-10"}
    >
      <EditorVoiceControl
        onTranscript={insertTranscript}
        focused={isFocused}
        {disabled}
        showMic={mic}
      />
    </div>
  {/if}
</div>
