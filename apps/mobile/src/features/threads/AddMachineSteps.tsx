import type { StatusCardState, StatusCardStep } from "@solus/contracts/types";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

// One add of the Add machine card as setup steps (docs/plans/add-machine-card.md),
// the rows a worktree setup draws: the same steps desktop and web show, from
// `addMachineStatusCard` in client-core.

const ICONS = {
  pending: "circle",
  done: "checkmark",
  skipped: "minus",
  warning: "exclamationmark.triangle",
  error: "xmark",
} as const satisfies Record<Exclude<StatusCardStep["status"], "active">, AppSymbolName>;

export function AddMachineSteps(props: { readonly card: StatusCardState }) {
  return (
    <View accessibilityLabel={props.card.title} accessibilityLiveRegion="polite" className="gap-1">
      <Text numberOfLines={1} className="font-t3-bold text-sm text-foreground">
        {props.card.title}
      </Text>
      {props.card.steps.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
    </View>
  );
}

function StepRow({ step }: { step: StatusCardStep }) {
  const stopped = step.status === "error" || step.status === "warning";
  return (
    <View>
      <View
        className="min-h-8 flex-row items-center"
        style={{ columnGap: 8, opacity: step.status === "pending" ? 0.4 : 1 }}
      >
        <View className="w-6 items-center">
          {step.status === "active" ? (
            <AppActivityIndicator
              size="small"
              colorClassName="accent-icon-muted"
              style={{ transform: [{ scale: 0.75 }] }}
            />
          ) : (
            <SymbolView
              name={ICONS[step.status]}
              size={14}
              tintColorClassName={
                step.status === "error"
                  ? "accent-danger-foreground"
                  : step.status === "warning"
                    ? "accent-warning-foreground"
                    : "accent-icon-muted"
              }
            />
          )}
        </View>
        <Text
          numberOfLines={1}
          className={
            step.status === "error"
              ? "flex-1 text-sm text-danger-foreground"
              : step.status === "active"
                ? "flex-1 text-sm text-foreground"
                : "flex-1 text-sm text-foreground-secondary"
          }
        >
          {step.label}
        </Text>
        {step.status === "active" && step.percent !== undefined ? (
          <Text
            className="text-2xs text-foreground-secondary"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {step.percent}%
          </Text>
        ) : null}
      </View>
      {stopped && step.detail ? (
        <Text
          selectable
          accessibilityRole={step.status === "error" ? "alert" : undefined}
          className={
            step.status === "error"
              ? "ml-8 text-xs leading-snug text-danger-foreground"
              : "ml-8 text-xs leading-snug text-foreground-muted"
          }
        >
          {step.detail}
        </Text>
      ) : null}
    </View>
  );
}
