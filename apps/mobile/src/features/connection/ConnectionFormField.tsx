// Adapted from T3 Code apps/mobile/src/features/connection/ConnectionFormField.tsx (MIT, see UPSTREAM.md).
import { View } from "react-native";

import { AppText, AppTextInput, type AppTextInputProps } from "../../components/AppText";
import { cn } from "../../lib/cn";

type ConnectionFormFieldProps = Omit<AppTextInputProps, "accessibilityLabel" | "className"> & {
  readonly label: string;
  readonly className?: string;
};

/** Labeled connection input with a native wrapper retained inside form sheets. As desktop: a short sentence-case label over a bordered input. */
export function ConnectionFormField({ label, className, ...inputProps }: ConnectionFormFieldProps) {
  return (
    <View collapsable={false} className={cn("gap-2", className)}>
      <AppText
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="text-[13px] text-foreground-muted"
      >
        {label}
      </AppText>
      <AppTextInput
        {...inputProps}
        accessibilityLabel={label}
        className="min-h-11 rounded-[12px] px-3.5 py-2.5"
      />
    </View>
  );
}
