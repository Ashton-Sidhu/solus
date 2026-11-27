import { use, useContext, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { InlinePreviewFrame } from "../features/threads/HtmlRenderWebView";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { InlineReviewGuide as Draft } from "@solus/contracts/inline-review-guide";
import { loadInlineReviewGuide } from "@solus/client-core/inline-review-guide";
import { GuideOutline } from "../features/pull-requests/guide/GuideOutline";
import { ReviewGuideExcerpt } from "../features/pull-requests/guide/ReviewGuideExcerpt";
import { PullRequestMarkdown } from "../features/pull-requests/PullRequestMarkdown";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { TurnDiffReader } from "./turn-diff-context";

function splitByFile(patch: string) {
  const files = new Map<string, string>();
  for (const chunk of patch.split(/(?=^diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const file = parsePatchFiles(chunk)[0]?.files[0];
    if (file) files.set(file.name, chunk);
  }
  return files;
}

const offline = async () => null;

export default function InlineReviewGuide({ draft }: { draft: Draft }) {
  const read = useContext(TurnDiffReader);
  const [position, setPosition] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const entry = useMemo(() => loadInlineReviewGuide(draft, read ?? offline, splitByFile), [draft, read, attempt]);
  const { guide, unavailable } = entry.value ?? use(entry.ready);
  const section = position === null ? null : guide.sections[position];
  const stops = guide.sections.map((item) => ({
    title: item.title, summary: "", attention: item.attention ?? null,
    files: item.files.map(({ path }) => ({ path })), excerpts: [], notes: [], questions: [],
  }));
  const content = (compact: boolean) => (
    <View className={compact ? "gap-2" : "gap-4"}>
      {unavailable.length > 0 && <View className="flex-row flex-wrap items-center gap-x-2 rounded-lg bg-grouped-card px-3">
        <AppText className="flex-1 text-sm text-foreground-muted">Could not read the snapshot for turn {unavailable.join(", ")}.</AppText>
        {read && <Button label="Retry" tone="text" onPress={() => { loadInlineReviewGuide(draft, read, splitByFile, true); setAttempt(value => value + 1); }} />}
      </View>}
      {section ? <>
        <Button label="Guide outline" tone="text" onPress={() => setPosition(null)} />
        <AppText className="text-lg font-t3-semibold">{section.title}</AppText>
        <PullRequestMarkdown markdown={section.explanation} />
        {section.attention && <PullRequestMarkdown markdown={section.attention.note} />}
        {section.files.map(file => file.hunks ? (
          <ReviewGuideExcerpt key={file.path} path={file.path} patch={file.hunks} />
        ) : <AppText key={file.path}>{file.missingFromTurn ? `${file.path} is absent from the turn ${file.missingFromTurn} patch.` : `Diff unavailable for ${file.path}.`}</AppText>)}
        {position !== null && position + 1 < stops.length &&
          <Button label="Next stop" tone="text" onPress={() => setPosition(position + 1)} />}
      </> : <>
        <PullRequestMarkdown markdown={guide.summary} />
        <GuideOutline compact={compact} guide={{stops}} onOpen={setPosition} />
      </>}
    </View>
  );
  return (
    <InlinePreviewFrame
      title={guide.title}
      heading={<AppText accessibilityRole="header" className="text-lg leading-6 font-t3-semibold">{guide.title}</AppText>}
      expandedContent={() => (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <View className="mx-auto w-full max-w-[760px]">{content(false)}</View>
        </ScrollView>
      )}
    >
      <View className="mt-2">{content(true)}</View>
    </InlinePreviewFrame>
  );
}
