import { Text, View } from 'react-native'
import type { PullRequest } from '@solus/contracts/providers'
import { useIsDark, usePalette } from '../../../theme/theme'
import { CODE_FONT } from '../../../theme/tokens'
import { AppSymbol } from '../../../ui/app-symbol'
import { PR_STATE_LABELS, prStateTone, type PrStateTone } from '../lib/pr-presentation'

/** T3 Code's pull request colors: open green, merged violet, closed rose, a
 *  draft muted, because it is not asking to land yet. */
const STATE_COLORS = {
  light: { open: '#059669', merged: '#7c3aed', closed: '#e11d48' },
  dark: { open: '#34d399', merged: '#a78bfa', closed: '#fb7185' },
} as const

export function usePrStateColor(tone: PrStateTone): string {
  const palette = usePalette()
  const colors = STATE_COLORS[useIsDark() ? 'dark' : 'light']
  return tone === 'draft' ? palette.textTertiary : colors[tone]
}

/** The pull request mark, "Open", and "#123", in the state's color. */
export function PrStateBadge({ pr }: { pr: Pick<PullRequest, 'state' | 'draft' | 'number'> }) {
  const tone = prStateTone(pr)
  const color = usePrStateColor(tone)
  return (
    <View accessible accessibilityLabel={`${PR_STATE_LABELS[tone]} pull request ${pr.number}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 3.5 }}>
      <AppSymbol name="pullRequest" size={12} weight="semibold" color={color} />
      <Text style={{ color, fontSize: 13, fontWeight: '600' }}>
        {PR_STATE_LABELS[tone]} <Text style={{ fontFamily: CODE_FONT, fontWeight: '400' }}>#{pr.number}</Text>
      </Text>
    </View>
  )
}
