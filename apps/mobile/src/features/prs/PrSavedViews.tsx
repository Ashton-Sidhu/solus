import { useState } from 'react'
import { Alert, View } from 'react-native'
import { putPrSavedView, type PrViewFilters } from '@solus/contracts/pr-views'
import { useApp, useListened } from '../../app/app-context'
import { ActionButton, FormField } from '../../components/FormControls'

export function PrSavedViews({
  filters,
  onApply
}: {
  filters: PrViewFilters
  onApply: (filters: PrViewFilters) => void
}) {
  const app = useApp(),
    settings = useListened(app.personal.changes, app.personal.current)
  const [expanded, setExpanded] = useState(false)
  const [name, setName] = useState(''),
    [editingId, setEditingId] = useState<string | null>(null)
  return (
    <View className="gap-2 px-4 pb-3">
      <ActionButton onPress={() => setExpanded(!expanded)}>
        Saved views ({settings.prSavedViews.length})
      </ActionButton>
      {expanded ? (
        <>
          {settings.prSavedViews.map((view) => (
            <View key={view.id} className="gap-1">
              <ActionButton onPress={() => onApply(view.filters)}>{view.name}</ActionButton>
              <View className="flex-row gap-2">
                <ActionButton
                  onPress={() => {
                    setEditingId(view.id)
                    setName(view.name)
                  }}
                >
                  Rename
                </ActionButton>
                <ActionButton
                  onPress={() => {
                    if (
                      app.personal.set({
                        prSavedViews: settings.prSavedViews.filter((held) => held.id !== view.id)
                      }) !== 'saved'
                    )
                      Alert.alert('Could not remove PR view')
                  }}
                >
                  Remove
                </ActionButton>
              </View>
            </View>
          ))}
          <FormField
            label={editingId ? 'View name' : 'Save current view as'}
            value={name}
            onChangeText={setName}
            maxLength={100}
          />
          <View className="flex-row gap-2">
            <ActionButton
              disabled={!name.trim() || (!editingId && settings.prSavedViews.length >= 50)}
              onPress={() => {
                try {
                  const held = settings.prSavedViews.find((view) => view.id === editingId)
                  const result = app.personal.set({
                    prSavedViews: putPrSavedView(settings.prSavedViews, {
                      id: editingId ?? app.platform.uuid(),
                      name,
                      filters: held?.filters ?? filters
                    })
                  })
                  if (result !== 'saved') {
                    Alert.alert('Could not save PR view')
                    return
                  }
                  setName('')
                  setEditingId(null)
                } catch (error) {
                  Alert.alert(
                    'Could not save PR view',
                    error instanceof Error ? error.message : String(error)
                  )
                }
              }}
            >
              Save view
            </ActionButton>
            {editingId ? (
              <ActionButton
                onPress={() => {
                  setName('')
                  setEditingId(null)
                }}
              >
                Cancel
              </ActionButton>
            ) : null}
          </View>
        </>
      ) : null}
    </View>
  )
}
