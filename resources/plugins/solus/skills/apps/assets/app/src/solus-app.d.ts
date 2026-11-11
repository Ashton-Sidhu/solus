// The types of `@solus/app`, the module the Solus app shell provides at run
// time. The build leaves it, React, TanStack Query, Recharts, and Lucide to
// the shell. Do not edit: the shell does not read this file.

declare module '@solus/app' {
  import type { QueryFilters, QueryKey, UseMutationOptions, UseQueryOptions } from '@tanstack/react-query'
  import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'

  /** A JSON value: all a call answers. What a call takes is sent as JSON too, so pass plain data. */
  export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

  /** One call to the host, with the TanStack Query helpers for it. `T` is the type you expect back; nothing checks it at run time. */
  interface CallTarget {
    <T = Json>(input?: object): Promise<T>
    queryOptions<T = Json>(input?: object, extras?: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>): UseQueryOptions<T> & { queryKey: QueryKey }
    queryKey(input?: object): QueryKey
    mutationOptions<T = Json, I extends object | void = object | void>(extras?: Omit<UseMutationOptions<T, Error, I>, 'mutationKey' | 'mutationFn'>): UseMutationOptions<T, Error, I>
    mutationKey(): QueryKey
    pathKey(): QueryKey
    /** Matches every query of this path: `queryClient.invalidateQueries(server.rows.pathFilter())`. */
    pathFilter(filters?: Omit<QueryFilters, 'queryKey'>): QueryFilters
  }
  export type CallPath = CallTarget & { [segment: string]: CallPath }

  /** The app's own host functions: `server.<name>(input)` runs the export `<name>` of `server.ts` on the host. */
  export const server: { [name: string]: CallPath }

  /** The user's connected integrations: `tools.<slug>.<tool>(args)`, with the viewer's own connection. */
  export const tools: { [slug: string]: CallPath }

  /** The app's own data on the host. It belongs to the app, not to a viewer. */
  export const storage: {
    /** The value kept under a key; null when there is none. `T` is the type you stored; nothing checks it at run time. */
    get<T = Json>(key: string): Promise<T | null>
    /** Keeps a value that JSON can hold. */
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
  }

  export interface AppRoleState {
    slug: string
    /** The integration's display name, when the viewer has one with this slug. */
    name: string | null
    connected: boolean
  }

  export interface AppState {
    roles: AppRoleState[]
    permissions: {
      tools: 'all' | 'read-only' | { selected: string[] }
      writes: 'ask' | 'allow'
      network: string[]
      files: { read: string[]; write: string[] }
    }
    /** Whether what the app asks of the host is in force: it asks for nothing, it waits for the host's owner, or the owner allowed it. */
    hostAccess: 'none' | 'pending' | 'allowed'
    theme: 'light' | 'dark'
  }

  /** What an app may ask about itself. */
  export function useApp(): AppState

  export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'destructive' }): ReactNode
  export function Card(props: HTMLAttributes<HTMLDivElement>): ReactNode
  export function CardTitle(props: HTMLAttributes<HTMLHeadingElement>): ReactNode
  export function CardDescription(props: HTMLAttributes<HTMLParagraphElement>): ReactNode
  export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactNode
  export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): ReactNode
  export function Badge(props: HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'success' | 'warning' | 'destructive' | 'info' }): ReactNode
  export function Table(props: TableHTMLAttributes<HTMLTableElement>): ReactNode
  export function TableHead(props: HTMLAttributes<HTMLTableSectionElement>): ReactNode
  export function TableBody(props: HTMLAttributes<HTMLTableSectionElement>): ReactNode
  export function TableRow(props: HTMLAttributes<HTMLTableRowElement>): ReactNode
  export function TableHeader(props: ThHTMLAttributes<HTMLTableCellElement>): ReactNode
  export function TableCell(props: TdHTMLAttributes<HTMLTableCellElement>): ReactNode
  export function Skeleton(props: HTMLAttributes<HTMLDivElement>): ReactNode
  export function Empty(props: HTMLAttributes<HTMLDivElement> & { title: string; children?: ReactNode }): ReactNode
  export function Stat(props: HTMLAttributes<HTMLDivElement> & { label: string; value: ReactNode; hint?: ReactNode }): ReactNode
  export function Tabs(props: { tabs: Array<{ id: string; label: string }>; value: string; onChange: (id: string) => void }): ReactNode
  /** A list beside its detail. The list goes above the detail when the app is narrow. */
  export function Split(props: HTMLAttributes<HTMLDivElement> & { side: ReactNode; children?: ReactNode }): ReactNode
  /** One row of a list a person picks from, such as the `side` of a `Split`. */
  export function NavItem(props: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean; icon?: ReactNode }): ReactNode
}
