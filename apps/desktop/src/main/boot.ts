// Desktop app entry (package.json `main`). It turns on the compile cache before
// the main bundle loads, so the cache also covers `index.js` itself. Keep this
// file free of other imports: everything it loads is compiled without the cache.
import { app } from 'electron'
import { createRequire } from 'node:module'
import { startCompileCache } from './compile-cache'

startCompileCache(app.isPackaged)
createRequire(import.meta.url)('./index.js')
