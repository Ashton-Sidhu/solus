import { useRef, useState } from 'react'
import { Alert, Linking, ScrollView, Text, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useApp } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { radius, space, type } from '../../theme/tokens'
import { Banner, Button, Card, Field } from '../../ui/primitives'
import { decodePairInput, decodeScannedCode, pairFailureMessage, type HostPreview, type PairInput } from './lib/pair-input'

/**
 * Pair with a host by its QR code, its pairing link, or its address and code
 * (plan 017 stage 2). The camera is asked for only when scanning is chosen,
 * and the target is shown before the device pairs with it. Presentation
 * adapted from T3 Code `ConnectionsNewRouteScreen` (MIT, see UPSTREAM.md);
 * decoding and pairing are Solus's own `/pair` flow.
 */
export function PairHostScreen({ navigation }: ScreenProps<'PairHost'>) {
  const app = useApp()
  const palette = usePalette()
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState<{ preview: HostPreview; pairToken: string | null } | null>(null)
  const [permission, requestPermission] = useCameraPermissions()
  const scanLocked = useRef(false)

  const inspect = async (input: PairInput) => {
    if (input.kind === 'invalid') {
      setError(input.message)
      return
    }
    setBusy(true)
    setError(null)
    const result = await app.preview(input.url)
    setBusy(false)
    if (result.kind === 'unreachable') {
      setError('The host did not answer. Check the address and that this device is on a network that can reach it.')
      return
    }
    if (result.kind === 'not-solus') {
      setError('A server answered at this address, but it is not a Solus host.')
      return
    }
    setTarget({ preview: result.preview, pairToken: input.pairToken })
  }

  const openScanner = async () => {
    if (permission?.granted) {
      scanLocked.current = false
      setScanning(true)
      return
    }
    const answer = await requestPermission()
    if (answer.granted) {
      scanLocked.current = false
      setScanning(true)
    } else if (!answer.canAskAgain) {
      Alert.alert('Camera access is off', 'Turn on camera access for Solus in Settings to scan a pairing code, or type the address and code.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => void Linking.openSettings() },
      ])
    }
  }

  const onScanned = ({ data }: { data: string }) => {
    if (scanLocked.current) return
    scanLocked.current = true
    setScanning(false)
    void inspect(decodeScannedCode(data))
  }

  const pair = async () => {
    if (!target?.pairToken) {
      setError('Enter the pairing code the host shows.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const host = await app.pair(target.preview, target.pairToken, label.trim() || undefined)
      navigation.reset({ index: 1, routes: [{ name: 'Hosts' }, { name: 'Projects', params: { hostId: host.id } }] })
    } catch (failure) {
      setError(pairFailureMessage(failure instanceof Error ? failure : new Error(String(failure))))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={{ backgroundColor: palette.canvas }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      {target ? (
        <Card>
          <Text accessibilityRole="header" style={{ color: palette.text, fontSize: type.title, fontWeight: '600' }}>{target.preview.name}</Text>
          <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>
            {target.preview.host}{target.preview.os ? ` · ${target.preview.os}` : ''}
          </Text>
          <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>Pair only with a host you trust. It will run agents for this device.</Text>
          {target.pairToken === null ? (
            <Field label="Pairing code" value={code} onChangeText={(value) => { setCode(value); setTarget({ ...target, pairToken: value.trim() || null }) }} placeholder="Shown on the host" />
          ) : null}
          <Field label="Name (optional)" value={label} onChangeText={setLabel} placeholder={target.preview.name} autoCapitalize="words" />
          {error ? <Banner message={error} /> : null}
          <Button tone="primary" label="Pair with this host" busy={busy} onPress={() => void pair()} />
          <Button tone="plain" label="Choose another host" onPress={() => { setTarget(null); setError(null) }} />
        </Card>
      ) : scanning ? (
        <View style={{ gap: space.md }}>
          <View style={{ overflow: 'hidden', borderRadius: radius.lg }}>
            <CameraView
              accessibilityLabel="Camera viewfinder for the host's pairing code"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onScanned}
              style={{ aspectRatio: 1, width: '100%' }}
            />
          </View>
          <Button label="Type the address instead" onPress={() => setScanning(false)} />
        </View>
      ) : (
        <Card>
          <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>
            Show the pairing code on the Solus host. Then scan it, paste its pairing link, or type the host's address and code.
          </Text>
          <Button tone="primary" label="Scan the pairing code" onPress={() => void openScanner()} />
          <Field label="Address or pairing link" value={address} onChangeText={setAddress} keyboardType="url" placeholder="192.168.1.20:3000" returnKeyType="next" />
          <Field label="Pairing code" value={code} onChangeText={setCode} placeholder="Shown on the host" returnKeyType="go" onSubmitEditing={() => void inspect(decodePairInput(address, code))} />
          {error ? <Banner message={error} /> : null}
          <Button label="Continue" busy={busy} disabled={!address.trim()} onPress={() => void inspect(decodePairInput(address, code))} />
        </Card>
      )}
    </ScrollView>
  )
}
