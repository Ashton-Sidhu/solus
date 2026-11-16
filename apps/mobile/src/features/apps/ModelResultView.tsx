import { View } from "react-native";

import type { ResultNode } from "@solus/client-core/model-result";

import { AppText as Text } from "../../components/AppText";
import { MonoBlock } from "./app-rows";

/**
 * What a model call returned (docs/plans/app-models.md §7), laid out as the
 * desktop and web Manage page lay it out: a titled record per item, short
 * values beside their labels, prose below. A list of short values is one
 * line of text, and a record inside a record is set in from it.
 */
export function ModelResultView(props: { readonly node: ResultNode; readonly depth?: number }) {
  const { node } = props;
  const depth = props.depth ?? 0;
  switch (node.kind) {
    case "text":
    case "short":
      return (
        <Text selectable className="text-sm text-foreground">
          {node.text}
        </Text>
      );
    case "tags":
      return (
        <Text selectable className="text-sm text-foreground">
          {node.items.join(" · ")}
        </Text>
      );
    case "items":
      return (
        <View className="gap-2">
          {node.items.map((item, index) => (
            <View key={index} className="flex-row gap-2 rounded-xl bg-subtle px-3 py-2.5">
              <Text className="w-4 text-xs text-foreground-muted">{index + 1}</Text>
              <View className="min-w-0 flex-1">
                <ModelResultView node={item} depth={depth + 1} />
              </View>
            </View>
          ))}
        </View>
      );
    case "record":
      return (
        <View className={depth > 0 && node.title === null ? "gap-3 pl-3" : "gap-3"}>
          {node.title || node.facts.length > 0 ? (
            <View className="gap-1">
              {node.title ? <Text className="text-sm font-t3-medium text-foreground">{node.title}</Text> : null}
              {node.facts.length > 0 ? (
                <View className="flex-row flex-wrap gap-x-3 gap-y-1">
                  {node.facts.map((fact) => (
                    <Text key={fact.label} className="text-xs text-foreground-muted">
                      {fact.label} <Text className="text-xs font-t3-medium text-foreground">{fact.text}</Text>
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
          {node.fields.map((field) => (
            <View key={field.label} className="gap-1">
              <Text className="text-xs font-t3-medium text-foreground-muted">{field.label}</Text>
              <ModelResultView node={field.node} depth={depth + 1} />
            </View>
          ))}
        </View>
      );
    case "json":
      return <MonoBlock text={node.text} maxLines={30} />;
  }
}
