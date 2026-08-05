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
  } from "../../../../shared/types";
  import type { ReferenceToken } from "../../editor/reference-tokens";
  import {
    createReferenceDecorations,
    extractTrackedReferences,
    insertReferenceAtCursor,
    replaceTriggerAtCursor,
    type ReferenceDecorationCallbacks,
    type ReferenceDecorationConfig,
  } from "./lib/reference-decorations";
  import { markdownComposerKeymap } from "./lib/markdown-keymap";
import { ghostCompletion, showGhost } from "./lib/ghost-completion";

  interface Props extends ReferenceDecorationCallbacks {
    value: string;
    onValueChange: (value: string) => void;
    onInput?: () => void;
    onEmptyChange?: (empty: boolean) => void;
    onKeyDown?: (event: KeyboardEvent) => void;
    onPaste?: (event: ClipboardEvent) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    placeholder?: string;
    ariaLabel?: string;
    hidePlaceholderOnFocus?: boolean;
    disabled?: boolean;
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
    maxHeight = 140,
    enterInsertsNewline = false,
    referenceChips = false,
    slashCommands = [],
    class: klass = "",
    style = "",
  }: Props = $props();

  let wrapper: HTMLDivElement | null = $state(null);
  let editorHost: HTMLDivElement | null = $state(null);
  let view: EditorView | null = $state.raw(null);
  let lastLocalValue: string | null = null;
  let isApplyingValue = false;
  // CodeMirror can synchronously blur while Svelte is reconciling a template.
  // Keep this imperative editor detail outside Svelte state and reconfigure the
  // placeholder directly from the focus handlers.
  let isFocused = false;
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
    { tag: tags.heading, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
  ]);

  const editorTheme = EditorView.theme({
    "&": {
      width: "100%",
      color: "var(--solus-text-primary)",
      backgroundColor: "transparent",
      fontFamily: "inherit",
      fontSize:
        "calc(var(--plain-editor-font-size, 0.8125rem) * var(--solus-font-scale, 1))",
      fontWeight: "var(--solus-font-weight-body, 400)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      maxHeight: "var(--plain-editor-max-height, 8.75rem)",
      overflowY: "auto",
      fontFamily: "inherit",
      // The font's own leading, which is also the box the browser draws the
      // caret from beside a character. Any looser and the caret standing on an
      // empty line — where it takes the whole line box — is visibly taller than
      // the one that replaces it on the first keystroke.
      lineHeight: "normal",
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
      // The caret is text, so it takes the text's colour — never the accent.
      caretColor: "currentColor",
      wordBreak: "break-word",
      whiteSpace: "pre-wrap",
    },
    ".cm-line": { padding: "0" },
    // Colour only: inheriting the line's own metrics is what lands the
    // placeholder's first character exactly where the first typed one goes.
    ".cm-placeholder": { color: "var(--solus-placeholder)" },
  });

  function isCompositionEvent(event: KeyboardEvent): boolean {
    return event.isComposing || event.keyCode === 229;
  }

  function setFocused(focused: boolean) {
    isFocused = focused;
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
          focus() {
            setFocused(true);
            onFocus?.();
            return false;
          },
          blur() {
            setFocused(false);
            onBlur?.();
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

  $effect(() => {
    if (!editorHost) return;
    const initialValue = untrack(() => value);
    const extensions = untrack(() => editorExtensions());
    const editorView = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: initialValue,
        selection: { anchor: initialValue.length },
        extensions,
      }),
    });
    view = editorView;
    untrack(() => onEmptyChange?.(initialValue.length === 0));
    return () => {
      editorView.destroy();
      if (view === editorView) view = null;
    };
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
    referenceConfig;
    if (!view) return;
    view.dispatch({
      effects: referenceCompartment.reconfigure(
        referenceChips ? references.extension : [],
      ),
    });
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
  class="relative w-full min-w-0 {klass}"
  style="--plain-editor-max-height:{maxHeight}px; {style}"
>
  <div bind:this={editorHost}></div>
</div>
