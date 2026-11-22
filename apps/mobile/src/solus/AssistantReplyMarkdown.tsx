import { lazy, Suspense, useMemo } from "react";
import { resolveArtifactTitle } from "@solus/contracts/work-preview";
import { InlineHtmlRender } from "../features/threads/HtmlRenderWebView";
import { replySegments } from "@solus-mobile/features/threads/reply-html-fences";
import { renderCodexInlineDirectivesAsMarkdown } from "@t3tools/shared/codexMarkdownDirectives";
import { markdownReferenceDefinitions, withReferenceDefinitions } from "../lib/markdownDocument";
import { SelectableMarkdownText } from "../native/SelectableMarkdownText";
import type { SelectableMarkdownTextProps } from "../native/SelectableMarkdownText.types";

const InlineReviewGuide = lazy(() => import("./InlineReviewGuide"));

export function AssistantReplyMarkdown({
  markdown,
  definitions,
  renderHtml,
  ...textProps
}: SelectableMarkdownTextProps & {
  readonly definitions: ReadonlyArray<string>;
  readonly renderHtml?: boolean | undefined;
}) {
  const segments = useMemo(
    () => (renderHtml ? replySegments(markdown) : []),
    [markdown, renderHtml],
  );
  const references = useMemo(
    () =>
      segments.length > 1 && !definitions.length
        ? markdownReferenceDefinitions(markdown)
        : definitions,
    [markdown, definitions, segments.length],
  );
  const renderText = (text: string, key: string) => (
    <SelectableMarkdownText
      key={key}
      {...textProps}
      markdown={renderCodexInlineDirectivesAsMarkdown(withReferenceDefinitions(text, references))}
    />
  );
  if (!renderHtml) return renderText(markdown, "md:0");
  return segments.map((segment) =>
    segment.kind === "guide" ? (
      <Suspense key={segment.key} fallback={renderText(segment.guide.title, segment.key)}>
        <InlineReviewGuide draft={segment.guide} />
      </Suspense>
    ) : segment.kind === "html" ? (
      <InlineHtmlRender
        key={segment.key}
        html={segment.html}
        title={resolveArtifactTitle(undefined, segment.html)}
      />
    ) : (
      renderText(segment.text, segment.key)
    ),
  );
}
