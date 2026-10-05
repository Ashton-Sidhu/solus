import { useEffect } from 'react'
import { ScrollView, Text } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { space, type } from '../../theme/tokens'
import { Banner, Button, Card } from '../../ui/primitives'

/**
 * Sign in to Solus Cloud with the account's device flow: the approval page
 * opens in the system browser and this screen shows the code to confirm.
 * Leaving the app and returning resumes the same wait; an expired code ends it.
 */
export function CloudSignInScreen({ navigation }: ScreenProps<'CloudSignIn'>) {
  const app = useApp()
  const palette = usePalette()
  const view = useListened(app.account.changes, () => app.account.view)

  useEffect(() => {
    if (view.kind === 'signed-in') navigation.replace('CloudHosts')
  }, [navigation, view.kind])

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: palette.canvas }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Card>
        {view.kind === 'signing-in' ? (
          <>
            <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>Confirm this code on the sign-in page:</Text>
            <Text accessibilityLabel={`Code ${view.userCode.split('').join(' ')}`} selectable style={{ color: palette.text, fontSize: 28, fontWeight: '700', letterSpacing: 2, fontVariant: ['tabular-nums'] }}>
              {view.userCode}
            </Text>
            <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>Waiting for approval. You can switch apps; this screen continues when you return.</Text>
            <Button label="Open the sign-in page again" onPress={() => void app.platform.openBrowser(view.verificationUrl)} />
            <Button tone="plain" label="Cancel" onPress={() => app.account.cancelSignIn()} />
          </>
        ) : (
          <>
            <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>
              Sign in to reach the hosts your Solus account can use. Hosts you paired directly stay on this device either way.
            </Text>
            {view.kind === 'signed-out' && view.message ? <Banner message={view.message} /> : null}
            <Button tone="primary" label="Sign in" busy={view.kind === 'loading'} onPress={() => void app.account.startSignIn()} />
          </>
        )}
      </Card>
    </ScrollView>
  )
}
