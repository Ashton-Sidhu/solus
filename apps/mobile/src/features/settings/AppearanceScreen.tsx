import { Pressable, Text, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { darkPalette, lightPalette, type Palette } from '../../theme/tokens'
import { APPEARANCE_MODES, type AppearanceMode } from './appearance'
import { APPEARANCE_DESCRIPTIONS, APPEARANCE_LABELS } from './lib/settings-labels'
import { GroupedFooter, GroupedScroll } from '../../ui/grouped-rows'

/** System, Light, or Dark: the person's theme, as T3 Code's mode cards. */
export function AppearanceScreen(_props: ScreenProps<'AppearanceSettings'>) {
  const app = useApp()
  const palette = usePalette()
  const mode = useListened(app.appearance.changes, app.appearance.current)

  return (
    <GroupedScroll>
      <View style={{ gap: 7 }}>
        <Text accessibilityRole="header" style={{ paddingHorizontal: 7, color: palette.textTertiary, fontSize: 14, lineHeight: 19, fontWeight: '500' }}>Color scheme</Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 7 }}>
          {APPEARANCE_MODES.map((candidate) => (
            <ModeCard key={candidate} mode={candidate} selected={mode === candidate} onPress={() => app.appearance.set(candidate)} />
          ))}
        </View>
      </View>
      <GroupedFooter text={`${APPEARANCE_DESCRIPTIONS[mode]} This is your setting: with sync on, your other devices use it too. System follows each device.`} />
    </GroupedScroll>
  )
}

function ModeCard({ mode, selected, onPress }: { mode: AppearanceMode; selected: boolean; onPress: () => void }) {
  const palette = usePalette()
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={APPEARANCE_LABELS[mode]}
      accessibilityHint={APPEARANCE_DESCRIPTIONS[mode]}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        gap: 7,
        padding: 7,
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? palette.accent : palette.border,
        backgroundColor: selected ? palette.accentSoft : palette.card,
        alignItems: 'center',
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <View style={{ width: 84, height: 49, marginTop: 7, borderRadius: 16, borderWidth: 1.5, borderColor: palette.border, padding: 3, backgroundColor: palette.canvas }}>
        <View style={{ flex: 1, flexDirection: 'row', borderRadius: 11, overflow: 'hidden' }}>
          {mode === 'system' ? (
            <>
              <ScreenSample palette={lightPalette} />
              <ScreenSample palette={darkPalette} />
            </>
          ) : (
            <ScreenSample palette={mode === 'dark' ? darkPalette : lightPalette} />
          )}
        </View>
      </View>
      <Text style={{ paddingBottom: 4, fontSize: 16, fontWeight: selected ? '700' : '400', color: selected ? palette.text : palette.textTertiary }}>{APPEARANCE_LABELS[mode]}</Text>
    </Pressable>
  )
}

/** A few lines of a conversation in one scheme's colors. */
function ScreenSample({ palette }: { palette: Palette }) {
  return (
    <View style={{ flex: 1, backgroundColor: palette.canvas, padding: 5, gap: 3 }}>
      <View style={{ alignSelf: 'flex-end', width: '55%', height: 6, borderRadius: 3, backgroundColor: palette.userBubble }} />
      <View style={{ width: '80%', height: 3, borderRadius: 2, backgroundColor: palette.textTertiary, opacity: 0.6 }} />
      <View style={{ width: '60%', height: 3, borderRadius: 2, backgroundColor: palette.textTertiary, opacity: 0.6 }} />
      <View style={{ marginTop: 'auto', height: 7, borderRadius: 4, backgroundColor: palette.card, borderWidth: 0.5, borderColor: palette.border }} />
    </View>
  )
}
