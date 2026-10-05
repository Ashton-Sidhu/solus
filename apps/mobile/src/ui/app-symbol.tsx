import { Pressable } from 'react-native'
import { SymbolView, type SymbolViewProps, type SymbolWeight } from 'expo-symbols'
import { usePalette } from '../theme/theme'
import { TOUCH_TARGET } from '../theme/tokens'

type PlatformSymbolNames = Exclude<SymbolViewProps['name'], string>
type SFSymbol = NonNullable<PlatformSymbolNames['ios']>
type AndroidSymbol = NonNullable<PlatformSymbolNames['android']>

/**
 * The app's icons by meaning, as T3 Code's `AppSymbol` maps them: an SF Symbol
 * on iOS and the matching Material Symbol on Android. A screen names what the
 * icon stands for; this table alone knows the platform names, and the package
 * types reject a name that does not exist.
 */
const SYMBOLS = {
  account: { ios: 'person.crop.circle', android: 'account_circle' },
  signIn: { ios: 'person.crop.circle.badge.plus', android: 'person_add' },
  sync: { ios: 'arrow.triangle.2.circlepath', android: 'sync' },
  appearance: { ios: 'paintbrush', android: 'palette' },
  agentDefaults: { ios: 'sparkles', android: 'auto_awesome' },
  notifications: { ios: 'bell.badge', android: 'notifications_active' },
  organization: { ios: 'building.2', android: 'domain' },
  hosts: { ios: 'desktopcomputer', android: 'computer' },
  host: { ios: 'server.rack', android: 'dns' },
  inbox: { ios: 'tray', android: 'inbox' },
  sourceControl: { ios: 'arrow.triangle.branch', android: 'account_tree' },
  about: { ios: 'info.circle', android: 'info' },
  notices: { ios: 'doc.text', android: 'description' },
  settings: { ios: 'gearshape', android: 'settings' },
  restart: { ios: 'arrow.uturn.forward', android: 'redo' },
  rename: { ios: 'textformat', android: 'text_fields' },
  refresh: { ios: 'arrow.clockwise', android: 'refresh' },
  connect: { ios: 'link', android: 'link' },
  disconnect: { ios: 'xmark.circle', android: 'link_off' },
  delete: { ios: 'trash', android: 'delete' },
  pullRequest: { ios: 'arrow.triangle.pull', android: 'merge' },
  folder: { ios: 'folder', android: 'folder' },
  file: { ios: 'doc', android: 'draft' },
  chevronRight: { ios: 'chevron.right', android: 'chevron_right' },
  checkmark: { ios: 'checkmark', android: 'check' },
} as const satisfies Record<string, { ios: SFSymbol; android: AndroidSymbol }>

export type AppSymbolName = keyof typeof SYMBOLS

export function AppSymbol({ name, size = 22, color, weight = 'regular' }: {
  name: AppSymbolName
  size?: number
  /** Defaults to the text color, as T3 Code's `icon` token. */
  color?: string
  weight?: SymbolWeight
}) {
  const palette = usePalette()
  return (
    <SymbolView
      accessible={false}
      importantForAccessibility="no"
      name={SYMBOLS[name]}
      size={size}
      weight={weight}
      tintColor={color ?? palette.text}
      style={{ width: size, height: size }}
    />
  )
}

/** A header button that is only a symbol, as T3 Code's header items: a 44px
 *  target, the accent tint, and the label for assistive technology. */
export function SymbolButton({ name, label, onPress }: { name: AppSymbolName; label: string; onPress: () => void }) {
  const palette = usePalette()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => ({ width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
    >
      <AppSymbol name={name} color={palette.accent} />
    </Pressable>
  )
}
