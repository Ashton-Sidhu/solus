import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { msg, useGT, useLocale, useMessages } from "gt-react-native";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import type { MessageResolver } from "../../../i18n/messages";
import { SelectRow } from "./ScheduledTaskFields";

const DAYS = [1, 2, 3, 4, 5, 6, 0].map((index) => ({ index }));

// 2024-01-07 was a Sunday, so day index 0 to 6 maps onto Sunday to Saturday.
function weekdayLabel(index: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    Date.UTC(2024, 0, 7 + index),
  );
}

export function formatTime(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  const time = new Date();
  time.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatRunAtDate(value: Date): string {
  return value.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export function formatRunAtTime(value: Date): string {
  return value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function timePickerValue(value: string): Date {
  const [hours, minutes] = value.split(":").map(Number);
  const time = new Date();
  time.setHours(
    Number.isInteger(hours) ? (hours ?? 9) : 9,
    Number.isInteger(minutes) ? (minutes ?? 0) : 0,
    0,
    0,
  );
  return time;
}

function isWeekdays(weekdays: ReadonlyArray<number>): boolean {
  const days = new Set(weekdays);
  return days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day));
}

export function repeatLabel(
  weekdays: ReadonlyArray<number>,
  resolve: MessageResolver,
  locale: string,
): string {
  const days = new Set(weekdays);
  if (days.size === 7) return resolve(msg("Every day"));
  if (isWeekdays(weekdays)) return resolve(msg("Weekdays"));
  return (
    DAYS.filter((day) => days.has(day.index))
      .map((day) => weekdayLabel(day.index, locale))
      .join(", ") || resolve(msg("Choose days"))
  );
}

export function WeeklyScheduleFields({
  timeOfDay,
  weekdays,
  runAtZone,
  onTimeChange,
  onDaysChange,
}: {
  timeOfDay: string;
  weekdays: ReadonlyArray<number>;
  runAtZone?: string;
  onTimeChange: (time: string) => void;
  onDaysChange: (days: number[]) => void;
}) {
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const gt = useGT(),
    m = useMessages(),
    locale = useLocale();
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          runAtZone
            ? gt("Time, {time} {zone}", {
                time: formatTime(timeOfDay),
                zone: runAtZone,
              })
            : gt("Time, {time}", { time: formatTime(timeOfDay) })
        }
        onPress={() => setTimePickerOpen((open) => !open)}
        className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
      >
        <Text textRole="body" className="text-foreground">
          {gt("Time", { $context: "time of day" })}
        </Text>
        <Text textRole="footnote" className="min-w-0 flex-1 text-right text-foreground-muted">
          {formatTime(timeOfDay)}
          {runAtZone ? ` ${runAtZone}` : ""}
        </Text>
        <SymbolView
          name="chevron.right"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
      {timePickerOpen ? (
        <DateTimePicker
          value={timePickerValue(timeOfDay)}
          mode="time"
          display={Platform.OS === "ios" ? "spinner" : "default"}
          onDismiss={() => setTimePickerOpen(false)}
          onValueChange={(_, selected) => {
            const timeOfDay = `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`;
            if (Platform.OS === "android") setTimePickerOpen(false);
            onTimeChange(timeOfDay);
          }}
        />
      ) : null}
      <SelectRow
        label={gt("Repeat", { $context: "noun, which days a task repeats on" })}
        value={repeatLabel(weekdays, m, locale)}
        borderTop
        actions={[
          {
            id: "every_day",
            title: gt("Every day"),
            state: weekdays.length === 7 ? "on" : undefined,
          },
          {
            id: "weekdays",
            title: gt("Weekdays"),
            state: isWeekdays(weekdays) ? "on" : undefined,
          },
          ...DAYS.map((day) => ({
            id: String(day.index),
            title: weekdayLabel(day.index, locale),
            attributes: { keepsMenuPresented: true },
            state: weekdays.includes(day.index) ? ("on" as const) : undefined,
          })),
        ]}
        onSelect={(id) => {
          if (id === "every_day") onDaysChange(DAYS.map((day) => day.index));
          else if (id === "weekdays") onDaysChange([1, 2, 3, 4, 5]);
          else {
            const day = DAYS.find((day) => String(day.index) === id);
            if (day)
              onDaysChange(
                weekdays.includes(day.index)
                  ? weekdays.filter((index) => index !== day.index)
                  : [...weekdays, day.index],
              );
          }
        }}
      />
    </>
  );
}

export function OnceScheduleFields({
  runAt,
  onChange,
}: {
  runAt: Date;
  onChange: (selected: Date) => void;
}) {
  const [runAtPicker, setRunAtPicker] = useState<"date" | "time" | null>(null);
  const gt = useGT();
  return (["date", "time"] as const).map((field) => {
    const label = field === "date" ? formatRunAtDate(runAt) : formatRunAtTime(runAt);
    return (
      <View key={field}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            field === "date"
              ? gt("Date, {date}", { date: label })
              : gt("Time, {time}", { time: label })
          }
          onPress={() => setRunAtPicker((open) => (open === field ? null : field))}
          className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
        >
          <Text textRole="body" className="text-foreground">
            {field === "date" ? gt("Date") : gt("Time", { $context: "time of day" })}
          </Text>
          <Text textRole="footnote" className="min-w-0 flex-1 text-right text-foreground-muted">
            {label}
          </Text>
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </Pressable>
        {runAtPicker === field ? (
          <DateTimePicker
            value={runAt}
            mode={field}
            display={Platform.OS === "ios" ? "spinner" : "default"}
            onDismiss={() => setRunAtPicker(null)}
            onValueChange={(_, selected) => {
              // Android shows a dialog that closes on pick; iOS stays inline.
              if (Platform.OS === "android") setRunAtPicker(null);
              onChange(selected);
            }}
          />
        ) : null}
      </View>
    );
  });
}
