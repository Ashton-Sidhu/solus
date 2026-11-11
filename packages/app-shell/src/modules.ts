/**
 * What an app's `require` answers (docs/plans/apps.md §4). A component's
 * `import { useQuery } from '@tanstack/react-query'` is compiled into
 * `require('@tanstack/react-query')`, and this map is its whole module space.
 * A bundle carries every other package inside itself and asks only for
 * these, so an app and the shell share one React. An unknown name is a named
 * error, not a silent undefined.
 */

import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactQuery from '@tanstack/react-query'
import * as Recharts from 'recharts'
import * as Lucide from 'lucide-react'
import { useApp } from './app-context'
import type { AppStorage } from './app-storage'
import type { ToolPath } from './tools-proxy'
import * as Ui from './ui/index'

/** The names an app may import from the shell, for the error below. */
const PROVIDED_MODULES = ['react', 'react-dom', '@tanstack/react-query', 'recharts', 'lucide-react', '@solus/app'] as const

/** The three objects an app reaches the host through. */
export interface AppHostObjects {
  tools: ToolPath
  storage: AppStorage
  server: ToolPath
}

function providedModules(host: AppHostObjects) {
  return {
    react: React,
    'react/jsx-runtime': JsxRuntime,
    'react/jsx-dev-runtime': JsxRuntime,
    'react-dom': ReactDom,
    'react-dom/client': ReactDomClient,
    '@tanstack/react-query': ReactQuery,
    recharts: Recharts,
    'lucide-react': Lucide,
    '@solus/app': { ...Ui, tools: host.tools, storage: host.storage, server: host.server, useApp },
  }
}

type ProvidedModules = ReturnType<typeof providedModules>
export type ProvidedModule = ProvidedModules[keyof ProvidedModules]
export type ComponentRequire = (name: string) => ProvidedModule

export function createRequire(host: AppHostObjects): ComponentRequire {
  const modules = new Map<string, ProvidedModule>(Object.entries(providedModules(host)))
  return (name) => {
    const found = modules.get(name)
    if (found === undefined) throw new Error(`An app cannot import "${name}" from the shell. A component may import ${PROVIDED_MODULES.join(', ')}; for any other package, build an app project with the apps skill.`)
    return found
  }
}
