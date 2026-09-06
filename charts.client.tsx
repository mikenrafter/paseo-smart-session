import type { PluginSurfaceProps } from "@getpaseo/plugin";
import React from "react";
import { Text, View } from "react-native";

import { formatTokens, rampStep } from "./format.shared";

type Theme = PluginSurfaceProps["theme"];

/**
 * A sequential ramp: one hue, light to dark.
 *
 * Magnitude gets a single hue at stepped intensities — never a rainbow, and never
 * the status colours, which are reserved for state. The host gives one accent hue
 * and no scale, so the steps come from opacity over the chart surface, which is the
 * same construction as a lightness ramp for a single hue.
 */
const STEPS = [0.12, 0.3, 0.5, 0.72, 1] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Tokens by weekday and hour of day, in local time.
 *
 * The question this answers is "when am I actually working the model hardest", so
 * the cell is the unit and the ramp carries the magnitude. Hour labels are shown
 * every six hours: a label on all 24 would be unreadable at this width.
 */
export function HourHeatmap({
  theme,
  cells,
  compact,
}: {
  theme: Theme;
  cells: readonly { weekday: number; hour: number; tokens: number }[];
  compact: boolean;
}) {
  const grid = new Map<string, number>();
  let max = 0;
  for (const cell of cells) {
    grid.set(`${cell.weekday}|${cell.hour}`, cell.tokens);
    if (cell.tokens > max) max = cell.tokens;
  }

  const size = compact ? 9 : 12;
  const gap = 2;

  return (
    <View style={{ gap: 6 }}>
      <View style={{ gap }}>
        {WEEKDAYS.map((label, weekday) => (
          <View key={label} style={{ flexDirection: "row", alignItems: "center", gap }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, width: 28 }}>{label}</Text>
            {Array.from({ length: 24 }, (unused, hour) => {
              const tokens = grid.get(`${weekday}|${hour}`) ?? 0;
              const step = rampStep(tokens, max, STEPS.length);
              return (
                <View
                  key={hour}
                  style={{
                    width: size,
                    height: size,
                    borderRadius: 2,
                    // An empty hour is the surface, not a faint accent: absence and
                    // "a little" must not look alike.
                    backgroundColor: step === -1 ? theme.colors.surface2 : theme.colors.accent,
                    opacity: step === -1 ? 0.35 : STEPS[step],
                  }}
                />
              );
            })}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap, marginLeft: 28 + gap }}>
        {Array.from({ length: 24 }, (unused, hour) => (
          <View key={hour} style={{ width: size, alignItems: "center" }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>
              {hour % 6 === 0 ? String(hour) : ""}
            </Text>
          </View>
        ))}
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        Local time. Darkest cell is {formatTokens(max)} tokens.
      </Text>
    </View>
  );
}

/**
 * Tokens per day.
 *
 * One series, so no legend — the heading names it — and one label, on the peak,
 * rather than a number over every bar.
 */
export function DailyBars({
  theme,
  days,
  compact,
}: {
  theme: Theme;
  days: readonly { day: string; tokens: number }[];
  compact: boolean;
}) {
  if (days.length === 0) return null;
  const max = days.reduce((peak, point) => Math.max(peak, point.tokens), 0);
  const height = compact ? 48 : 64;
  const peakDay = days.reduce((best, point) => (point.tokens > best.tokens ? point : best), days[0]!);

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height }}>
        {days.map((point) => (
          <View
            key={point.day}
            style={{
              flex: 1,
              height: max === 0 ? 1 : Math.max(2, (point.tokens / max) * height),
              backgroundColor: theme.colors.accent,
              opacity: point.day === peakDay.day ? 1 : 0.65,
              // Rounded at the data end only; the baseline end stays square so the
              // bar reads as anchored rather than floating.
              borderTopLeftRadius: 3,
              borderTopRightRadius: 3,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{days[0]!.day.slice(5)}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
          peak {peakDay.day.slice(5)} · {formatTokens(peakDay.tokens)}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
          {days[days.length - 1]!.day.slice(5)}
        </Text>
      </View>
    </View>
  );
}

/** A ranked list — a bar chart of eight rows would say the same thing with more ink. */
export function RankedTotals({
  theme,
  rows,
  total,
}: {
  theme: Theme;
  rows: readonly { name: string; tokens: number }[];
  total: number;
}) {
  return (
    <View style={{ gap: 4 }}>
      {rows.map((row) => (
        <View key={row.name} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View
            style={{
              flexGrow: 1,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.colors.surface2,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${total === 0 ? 0 : (row.tokens / total) * 100}%`,
                height: 4,
                backgroundColor: theme.colors.accent,
              }}
            />
          </View>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, width: 130 }} numberOfLines={1}>
            {row.name}
          </Text>
          <Text
            style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"], width: 52, textAlign: "right" }}
          >
            {formatTokens(row.tokens)}
          </Text>
        </View>
      ))}
    </View>
  );
}
