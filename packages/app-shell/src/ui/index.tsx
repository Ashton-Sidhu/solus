/**
 * The UI primitives an app may import from `@solus/app`. They draw what the
 * Solus workspace draws (`packages/workspace-ui/src/components/ui/`): the same
 * soft cards, the same table, the same quiet hover, so an app reads as part of
 * the pane around it in both themes. An app composes these with Tailwind
 * utilities.
 *
 * One rule of the palette shapes every class here: `accent` and `primary` are
 * the terracotta accent, used for one main action. A hover, a selected row,
 * and a zebra stripe are `muted`, never `accent`.
 */

import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { twMerge } from 'tailwind-merge'

/**
 * A primitive's own classes, then the caller's. The caller's class wins over
 * the primitive's for the same property (`p-0` over `p-4`): without the merge
 * both stay on the element and the stylesheet's order picks one.
 */
const join = (...classes: Array<string | false | undefined>): string => twMerge(classes)

/** The focus ring of every control: the accent as a border and a soft ring, as the workspace draws it. */
const FOCUS = 'outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'

const BUTTON_VARIANTS = {
  primary: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/85',
  secondary: 'border-border bg-background text-foreground hover:bg-muted',
  ghost: 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
  destructive: 'border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20',
} satisfies Record<ButtonVariant, string>

export function Button({ variant = 'secondary', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...rest}
      className={join(
        'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium whitespace-nowrap transition-colors select-none active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0',
        FOCUS,
        BUTTON_VARIANTS[variant],
        className,
      )}
    />
  )
}

/** A soft card on the page background: the surface of one group of content. Do not put a Card or a Table inside a Card. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={join('rounded-xl border border-border/60 bg-card p-4 text-card-foreground', className)} />
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 {...rest} className={join('text-sm leading-5 font-medium text-foreground', className)} />
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...rest} className={join('text-[13px] leading-5 text-muted-foreground', className)} />
}

const CONTROL = 'h-8 rounded-lg border border-input bg-background text-[13px] text-foreground transition-colors placeholder:text-muted-foreground disabled:opacity-50'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={join(CONTROL, FOCUS, 'w-full min-w-0 px-2.5', className)} />
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={join(CONTROL, FOCUS, 'px-2', className)} />
}

type BadgeTone = 'neutral' | 'success' | 'warning' | 'destructive' | 'info'

const BADGE_TONES = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  destructive: 'bg-destructive/12 text-destructive',
  info: 'bg-info/12 text-info',
} satisfies Record<BadgeTone, string>

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span {...rest} className={join('inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap', BADGE_TONES[tone], className)} />
}

/** The Solus table: its own soft card, tracked column heads, and hairlines between rows. It scrolls sideways by itself; do not wrap it in a Card. */
export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-xl border border-border/60 bg-card">
      <table {...rest} className={join('w-full border-collapse text-[13px]', className)} />
    </div>
  )
}

export function TableHead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...rest} className={join('text-left', className)} />
}

export function TableBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />
}

/** A row with a hairline above it and a quiet hover. A row in the head has neither. */
export function TableRow({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...rest} className={join('border-t border-border/50 transition-colors [tbody>&]:hover:bg-muted/60 [thead>&]:border-t-0', className)} />
}

export function TableHeader({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...rest} className={join('h-9 px-4 align-middle text-[10px] font-medium tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase', className)} />
}

export function TableCell({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...rest} className={join('px-4 py-2 align-middle', className)} />
}

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} aria-hidden="true" className={join('animate-pulse rounded-lg bg-muted', className)} />
}

export function Empty({ title, children, className, ...rest }: HTMLAttributes<HTMLDivElement> & { title: string; children?: ReactNode }) {
  return (
    <div {...rest} className={join('flex flex-col items-center justify-center gap-1 px-4 py-10 text-center', className)}>
      <div className="text-sm font-medium text-foreground">{title}</div>
      {children ? <div className="max-w-[40ch] text-[13px] leading-5 text-muted-foreground">{children}</div> : null}
    </div>
  )
}

export function Stat({ label, value, hint, className, ...rest }: HTMLAttributes<HTMLDivElement> & { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div {...rest} className={join('rounded-xl border border-border/60 bg-card p-4', className)}>
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-medium tracking-tight text-foreground tabular-nums">{value}</div>
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
    <div role="tablist" className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          onClick={() => onChange(tab.id)}
          className={join('h-7 rounded-md px-2.5 text-[13px] font-medium transition-colors', FOCUS, tab.id === value ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A list beside its detail: the list is a narrow column on the left, and it
 * goes above the detail when the app's own width is under 40rem. The query is
 * on the app's width, not the window's, because an app opens in a pane.
 */
export function Split({ side, children, className, ...rest }: HTMLAttributes<HTMLDivElement> & { side: ReactNode; children?: ReactNode }) {
  return (
    <div {...rest} className={join('@container', className)}>
      <div className="grid gap-4 @[40rem]:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="min-w-0">{side}</div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  )
}

/** One row of a list a person picks from, such as the list of a `Split`. The picked row has the quiet fill, never the accent. */
export function NavItem({ selected = false, icon, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      {...rest}
      className={join(
        'flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-transparent px-2.5 text-left text-[13px] transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0',
        FOCUS,
        selected ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        className,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}
