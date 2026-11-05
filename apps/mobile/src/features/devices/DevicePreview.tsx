import { useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { WebView } from 'react-native-webview'
import { z } from 'zod'
import type { DeviceInput, DevicePreview as Preview } from '@solus/contracts/device-types'
import { useApp } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { devicePreviewSource } from './device-preview-source.generated'

const messageSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('url'), requestId: z.number().int() }), z.object({ kind: z.literal('status'), text: z.string() })])
export function DevicePreview(props: { hostId: string; preview: Preview; kind: 'local' | 'ssh' | 'simlock'; enabled: boolean; input: DeviceInput | null }) {
  const app = useApp()
  const view = useRef<WebView<{ deviceId?: string }>>(null)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState('Connecting…')
  const source = useMemo(() => ({ html: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"><style>html,body{margin:0;width:100%;height:100%;background:transparent}body{display:flex;align-items:center;justify-content:center}canvas{max-width:100%;max-height:100%;object-fit:contain;touch-action:none}</style></head><body><canvas aria-label="Device screen"></canvas><script>${devicePreviewSource.replaceAll('</script', '<\\/script')}</script></body></html>` }), [])
  useEffect(() => { if (loaded) view.current?.injectJavaScript(`window.solusDevice.enabled(${JSON.stringify(props.enabled)});true;`) }, [loaded, props.enabled])
  useEffect(() => { if (loaded && props.input) view.current?.injectJavaScript(`window.solusDevice.input(${JSON.stringify(props.input)});true;`) }, [loaded, props.input])
  return <View className="min-h-64 flex-1">
    <WebView<{ deviceId?: string }> ref={view} source={source} originWhitelist={['about:*']} allowsInlineMediaPlayback mediaPlaybackRequiresUserAction={false} scrollEnabled={false} style={{ flex: 1, backgroundColor: 'transparent' }}
      onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
      onLoad={() => { setLoaded(true); view.current?.injectJavaScript(`window.solusDevice.start(${JSON.stringify(props.preview.platform)},${JSON.stringify(props.kind)});window.solusDevice.enabled(${JSON.stringify(props.enabled)});true;`) }}
      onError={() => setStatus('The device preview failed. Close it and try again.')}
      onMessage={(event) => {
        let data: ReturnType<typeof messageSchema.safeParse>
        try { data = messageSchema.safeParse(JSON.parse(event.nativeEvent.data)) } catch { return }
        const parsed = data
        if (!parsed.success) return
        const message = parsed.data
        if (message.kind === 'status') { setStatus(message.text); return }
        void app.devices.streamUrl(props.hostId, props.preview).then((url) => view.current?.injectJavaScript(`window.solusDevice.url(${message.requestId},${JSON.stringify(url)});true;`)).catch(() => view.current?.injectJavaScript(`window.solusDevice.url(${message.requestId},null);true;`))
      }} />
    {status ? <Text accessibilityRole="status" className="p-3 text-center text-base text-foreground-muted">{status}</Text> : null}
  </View>
}
