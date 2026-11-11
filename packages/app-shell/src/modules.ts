/**
 * What a component's `require` answers (docs/plans/apps.md §4). The server
 * compiles `import { useQuery } from '@tanstack/react-query'` into
 * `require('@tanstack/react-query')`, and this map is the whole module space
 * a component has. An unknown name is a named error, not a silent undefined.
 */

import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactQuery from '@tanstack/react-query'
import * as Recharts from 'recharts'
import * as Lucide from 'lucide-react'
import { useApp } from './app-context'
import type { ToolPath } from './tools-proxy'
import * as Ui from './ui/index'

/** The names a component may import, for the error below. */
const PROVIDED_MODULES = ['react', 'react-dom', '@tanstack/react-query', 'recharts', 'lucide-react', '@solus/app'] as const

function providedModules(tools: ToolPath) {
  return {
    react: React,
    'react/jsx-runtime': JsxRuntime,
    'react/jsx-dev-runtime': JsxRuntime,
    'react-dom': ReactDom,
    'react-dom/client': ReactDomClient,
    '@tanstack/react-query': ReactQuery,
    recharts: Recharts,
    'lucide-react': Lucide,
    '@solus/app': { ...Ui, tools, useApp },
  }
}

type ProvidedModules = ReturnType<typeof providedModules>
export type ProvidedModule = ProvidedModules[keyof ProvidedModules]
export type ComponentRequire = (name: string) => ProvidedModule

export function createRequire(tools: ToolPath): ComponentRequire {
  const modules = new Map<string, ProvidedModule>(Object.entries(providedModules(tools)))
  return (name) => {
    const found = modules.get(name)
    if (found === undefined) throw new Error(`An app cannot import "${name}". It may import ${PROVIDED_MODULES.join(', ')}.`)
    return found
  }
}
