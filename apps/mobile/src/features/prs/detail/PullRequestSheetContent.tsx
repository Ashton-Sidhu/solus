// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestSheetContent.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from '@react-navigation/native'
import type { ReactNode } from 'react'
import { Platform, ScrollView, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SheetHeader } from '../../../components/SheetHeader'
import { NativeStackScreenOptions } from '../../../native/StackHeader'

/**
 * The frame of a pull request sheet: the sheet header (the route's native
 * bar on iOS, as T3 Code #22390), the form, and a footer with the main action
 * above the keyboard. While a write runs, the sheet cannot be closed or edited.
 */
export function PullRequestSheetContent(props: {
  readonly title: string
  readonly subtitle: string
  readonly busy?: boolean
  readonly children: ReactNode
  readonly footer?: ReactNode
}) {
  const navigation = useNavigation()
  const insets = useSafeAreaInsets()
  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ gestureEnabled: !props.busy }} />
      <SheetHeader
        presentation={Platform.OS === 'android' ? 'inline' : 'native'}
        title={props.title}
        subtitle={props.subtitle}
        onCancel={() => navigation.goBack()}
        dismissDisabled={props.busy}
      />
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 20 }}
      >
        <View className="gap-4" pointerEvents={props.busy ? 'none' : 'auto'}>{props.children}</View>
      </ScrollView>
      {props.footer ? <View className="bg-sheet px-4 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>{props.footer}</View> : null}
    </KeyboardAvoidingView>
  )
}
