// Adapted from T3 Code apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx (MIT, see UPSTREAM.md).
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";

/** The quiet line T3 sets under a section: what it changes, or why it cannot. */
export function SettingsNote(props: {
  readonly children: string;
  readonly tone?: "muted" | "danger";
}) {
  return (
    <Text
      selectable={props.tone === "danger"}
      className={cn(
        "px-2 text-sm leading-normal",
        props.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
      )}
    >
      {props.children}
    </Text>
  );
}
