import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { ELECTRON_RPC_CHANNEL, ELECTRON_RPC_SEND_CHANNEL, ELECTRON_EVENT_CHANNEL, RPC_TOPICS } from '../../shared/rpc'
import type { RpcEnvelope, RpcTopic } from '../../shared/rpc'
import type { SolusServer } from '../server/server'
import { createLogger } from '../logger'

const log = createLogger('main', 'electron-ipc')

/**
 * Thin Electron-IPC transport. Two channels:
 *
 *  - `solus:rpc`      (invoke)  → SolusServer.handle(method, args)
 *  - `solus:rpc-send` (send)    → SolusServer.handle(method, args), no result
 *  - `solus:event`    (server→) → SolusServer broadcast fans out via webContents.send
 *
 * The renderer keeps calling `window.solus.<method>(...args)`. The preload
 * Proxy translates each call into the envelope shape sent on these channels.
 */
export function attachElectronIpcTransport(server: SolusServer, getMainWindow: () => BrowserWindow | null): () => void {
  const HANDLER_CTX = { clientId: 'electron', deviceId: 'electron' }

  const invokeHandler = async (_event: Electron.IpcMainInvokeEvent, payload: RpcEnvelope) => {
    if (!server.hasHandler(payload?.method)) {
      throw new Error(`Unknown RPC method "${payload?.method}"`)
    }
    return await server.handle(payload.method, payload.args ?? [], HANDLER_CTX)
  }

  ipcMain.handle(ELECTRON_RPC_CHANNEL, invokeHandler)

  const sendHandler = (_event: Electron.IpcMainEvent, payload: RpcEnvelope) => {
    if (!server.hasHandler(payload?.method)) {
      log.warn(`unknown send method "${payload?.method}"`)
      return
    }
    void server.handle(payload.method, payload.args ?? [], HANDLER_CTX).catch((err) => {
      log.error(`send handler "${payload.method}" rejected: ${err}`)
    })
  }
  ipcMain.on(ELECTRON_RPC_SEND_CHANNEL, sendHandler)

  // Bridge every server topic into the renderer via webContents.send.
  const unsubs: Array<() => void> = []
  for (const topic of RPC_TOPICS) {
    unsubs.push(
      server.subscribe(topic as RpcTopic, (payload, seq) => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(ELECTRON_EVENT_CHANNEL, { topic, seq, payload })
      })
    )
  }

  return () => {
    ipcMain.removeHandler(ELECTRON_RPC_CHANNEL)
    ipcMain.removeListener(ELECTRON_RPC_SEND_CHANNEL, sendHandler)
    for (const u of unsubs) u()
  }
}
