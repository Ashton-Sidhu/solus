import { useState } from 'react'
import { View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../navigation/routes'
import { ActionButton, FormField } from '../../components/FormControls'

export function PrUrlInput({ hostId }: { hostId: string | null }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const [expanded, setExpanded] = useState(false)
  const [url, setUrl] = useState('')
  return (
    <View className="gap-2 px-4 pb-3">
      <ActionButton onPress={() => setExpanded(!expanded)}>
        {expanded ? 'Close URL inspection' : 'Inspect a PR URL'}
      </ActionButton>
      {expanded ? (
        <>
          <FormField
            label="PR URL"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            maxLength={2048}
          />
          <ActionButton
            disabled={!hostId || !url.trim()}
            onPress={() => {
              if (hostId) navigation.navigate('PrInspect', { hostId, url })
            }}
          >
            Inspect PR URL
          </ActionButton>
        </>
      ) : null}
    </View>
  )
}
