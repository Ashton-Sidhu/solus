import { ScrollView, Text, View } from 'react-native'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { space, type } from '../../theme/tokens'
import { Button } from '../../ui/primitives'

/** No saved host and no account: the two ways in. A cloud account is optional. */
export function WelcomeScreen({ navigation }: ScreenProps<'Welcome'>) {
  const palette = usePalette()
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: palette.canvas }} contentContainerStyle={{ padding: space.xl, gap: space.lg, flexGrow: 1, justifyContent: 'center' }}>
      <View style={{ gap: space.sm, marginBottom: space.lg }}>
        <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 34, fontWeight: '700' }}>Solus</Text>
        <Text style={{ color: palette.textSecondary, fontSize: type.body }}>Direct your coding agents from this device.</Text>
      </View>
      <Button tone="primary" label="Connect to a host" accessibilityHint="Pair with a Solus host by its code or address" onPress={() => navigation.navigate('PairHost')} />
      <Button label="Sign in to Solus Cloud" accessibilityHint="Use the hosts your Solus account can reach" onPress={() => navigation.navigate('CloudSignIn')} />
    </ScrollView>
  )
}
