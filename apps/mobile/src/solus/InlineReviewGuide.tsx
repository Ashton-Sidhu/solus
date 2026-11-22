import { useContext, useEffect, useState } from "react";
import { View } from "react-native";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { InlineReviewGuide as Draft } from "@solus/contracts/inline-review-guide";
import { resolveInlineReviewGuide } from "@solus/client-core/inline-review-guide";
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

export default function InlineReviewGuide({ draft }: { draft: Draft }) {
  const read = useContext(TurnDiffReader);
  const [result, setResult] = useState<Awaited<ReturnType<typeof resolveInlineReviewGuide>> | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    setPosition(null);
    void resolveInlineReviewGuide(draft, read ?? (async () => null), splitByFile).then(value => {
      if (active) setResult(value);
    });
    return () => { active = false; };
  }, [draft, read, attempt]);
  if (!result) return <AppText>Loading snapshot diffs…</AppText>;
  const { guide, unavailable } = result;
  const section = position === null ? null : guide.sections[position];
  const stops = guide.sections.map((item) => ({
    title: item.title, summary: "", attention: item.attention ?? null,
    files: item.files.map(({ path }) => ({ path })), excerpts: [], notes: [], questions: [],
  }));
  return (
    <View className="gap-4">
      <AppText className="text-xl font-t3-semibold">{guide.title}</AppText>
      {unavailable.length > 0 && <View>
        <AppText>Some files could not be loaded from turn {unavailable.join(", ")}.</AppText>
        {read && <Button label="Retry" tone="text" onPress={() => setAttempt(value => value + 1)} />}
      </View>}
      {section ? <>
        <Button label="Guide outline" tone="text" onPress={() => setPosition(null)} />
        <AppText className="text-lg font-t3-semibold">{section.title}</AppText>
        <PullRequestMarkdown markdown={section.explanation} />
        {section.attention && <PullRequestMarkdown markdown={section.attention.note} />}
        {section.files.map(file => file.hunks ? (
          <ReviewGuideExcerpt key={file.path} path={file.path} patch={file.hunks} />
        ) : <AppText key={file.path}>Diff unavailable for {file.path}.</AppText>)}
        {position !== null && position + 1 < stops.length &&
          <Button label="Next stop" tone="text" onPress={() => setPosition(position + 1)} />}
      </> : <>
        <PullRequestMarkdown markdown={guide.summary} />
        <GuideOutline guide={{stops}} onOpen={setPosition} />
      </>}
    </View>
  );
}
