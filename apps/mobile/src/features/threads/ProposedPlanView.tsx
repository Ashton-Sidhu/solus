import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { useGT } from "gt-react-native";
import { type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { CopyTextButton } from "./CopyTextButton";

export function ProposedPlanView(props: {
  markdown: string;
  title?: string;
  renderMarkdown: (markdown: string) => ReactNode;
  children: ReactNode;
}) {
  const gt = useGT();
  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row items-center gap-2">
        <Text accessibilityRole="header" className="flex-1 font-t3-bold text-base text-foreground">
          {props.title ?? proposedPlanTitle(props.markdown) ?? gt("Proposed plan")}
        </Text>
        <CopyTextButton
          accessibilityLabel={gt("Copy plan")}
          text={props.markdown.trimEnd() + "\n"}
        />
      </View>
      {props.renderMarkdown(stripDisplayedPlanMarkdown(props.markdown))}
      {props.children}
    </View>
  );
}
