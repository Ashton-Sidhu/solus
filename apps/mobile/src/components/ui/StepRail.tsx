import type { ReactNode } from "react";
import { View } from "react-native";

import { cn } from "../../lib/cn";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";

export interface StepRailStep {
  readonly title: string;
  readonly hint?: string;
  /** Without a state the steps are a list to follow, none of them done yet. */
  readonly state?: "done" | "current" | "next";
}

/**
 * Steps a person follows in order, as numbered circles joined by a rail — the
 * same rail the desktop and web sign-in draws. A done step has a check and its
 * part of the rail takes the accent; the current step has a soft ring.
 */
export function StepRail(props: {
  readonly steps: readonly StepRailStep[];
  /** Controls under one step's title and hint, such as a code field. */
  readonly renderDetail?: (step: StepRailStep, index: number) => ReactNode;
}) {
  return (
    <View>
      {props.steps.map((step, index) => {
        const isLast = index === props.steps.length - 1;
        const isDone = step.state === "done";
        const isCurrent = step.state === "current";
        const isActive = step.state === undefined || isCurrent;
        return (
          <View
            key={`${index}:${step.title}`}
            className="flex-row gap-3"
            accessibilityState={isCurrent ? { selected: true } : undefined}
          >
            <View className="w-[26px] items-center">
              <View
                className={cn(
                  "size-[26px] items-center justify-center rounded-full",
                  isCurrent ? "bg-primary/20" : "",
                )}
              >
                <View
                  className={cn(
                    "size-5 items-center justify-center rounded-full",
                    isDone || isCurrent ? "bg-primary" : "border-[1.5px] border-border bg-card",
                  )}
                >
                  {isDone ? (
                    <SymbolView
                      name="checkmark"
                      size={10}
                      tintColorClassName="accent-primary-foreground"
                    />
                  ) : (
                    <AppText
                      textRole="micro"
                      className={cn(
                        "font-t3-semibold",
                        isCurrent ? "text-primary-foreground" : "text-foreground-muted",
                      )}
                    >
                      {index + 1}
                    </AppText>
                  )}
                </View>
              </View>
              {isLast ? null : (
                <View
                  className={cn(
                    "my-1 w-[1.5px] flex-1 rounded-full",
                    isDone ? "bg-primary" : "bg-border",
                  )}
                />
              )}
            </View>
            <View className={cn("min-w-0 flex-1 pt-[3px]", isLast ? "" : "pb-4")}>
              <AppText
                textRole="footnote"
                className={cn(
                  "font-t3-medium",
                  isActive ? "text-foreground" : "text-foreground-muted",
                )}
              >
                {step.title}
              </AppText>
              {step.hint ? (
                <AppText textRole="caption" className="mt-0.5 text-foreground-muted">
                  {step.hint}
                </AppText>
              ) : null}
              {props.renderDetail?.(step, index)}
            </View>
          </View>
        );
      })}
    </View>
  );
}
