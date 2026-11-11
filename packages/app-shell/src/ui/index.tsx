/**
 * The UI primitives a component may import from `@solus/app`. They read the
 * Solus variables the frame receives, so an app looks like the pane around
 * it in both themes. Deliberately small: a component composes these with
 * Tailwind utilities rather than asking for more primitives.
 */

import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'

const join = (...classes: Array<string | false | undefined>): string => classes.filter(Boolean).join(' ')

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'

const BUTTON_VARIANTS = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'border border-border bg-card text-foreground hover:bg-accent',
  ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
} satisfies Record<ButtonVariant, string>

export function Button({ variant = 'secondary', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...rest}
      className={join(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring',
        BUTTON_VARIANTS[variant],
        className,
      )}
    />
  )
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={join('rounded-lg border border-border bg-card p-4 text-card-foreground', className)} />
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 {...rest} className={join('text-sm font-semibold', className)} />
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...rest} className={join('text-xs text-muted-foreground', className)} />
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={join('h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring', className)}
    />
  )
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={join('h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring', className)} />
}

type BadgeTone = 'neutral' | 'success' | 'warning' | 'destructive' | 'info'

const BADGE_TONES = {
  neutral: 'bg-secondary text-secondary-foreground',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/15 text-destructive',
  info: 'bg-info/15 text-info',
} satisfies Record<BadgeTone, string>

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span {...rest} className={join('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', BADGE_TONES[tone], className)} />
}

export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border">
      <table {...rest} className={join('w-full border-collapse text-sm', className)} />
    </div>
  )
}

export function TableHead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...rest} className={join('bg-muted/50 text-left text-xs text-muted-foreground', className)} />
}

export function TableBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />
}

export function TableRow({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...rest} className={join('border-t border-border first:border-t-0', className)} />
}

export function TableHeader({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...rest} className={join('px-3 py-2 font-medium', className)} />
}

export function TableCell({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...rest} className={join('px-3 py-2 align-top', className)} />
}

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} aria-hidden="true" className={join('animate-pulse rounded-md bg-muted', className)} />
}

export function Empty({ title, children, className, ...rest }: HTMLAttributes<HTMLDivElement> & { title: string; children?: ReactNode }) {
  return (
    <div {...rest} className={join('flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-4 py-8 text-center', className)}>
      <div className="text-sm font-medium text-foreground">{title}</div>
      {children ? <div className="text-xs text-muted-foreground">{children}</div> : null}
    </div>
  )
}

export function Stat({ label, value, hint, className, ...rest }: HTMLAttributes<HTMLDivElement> & { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div {...rest} className={join('rounded-lg border border-border bg-card p-4', className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

export interface TabsProps {
  tabs: Array<{ id: string; label: string }>
  value: string
  onChange: (id: string) => void
}

export function Tabs({ tabs, value, onChange }: TabsProps) {
  return (
    <div role="tablist" className="inline-flex gap-1 rounded-md bg-muted p-0.5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          onClick={() => onChange(tab.id)}
          className={join('rounded px-2.5 py-1 text-xs font-medium transition-colors', tab.id === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
