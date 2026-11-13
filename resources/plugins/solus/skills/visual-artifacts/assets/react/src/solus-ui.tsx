// `@solus/ui`: the controls of an app, drawn as Solus draws its own. Sizes,
// radius, hairlines, hover wash, and focus ring are the workspace's: a button
// is 32px tall, a row is 32px, text is 14px, secondary text is 12px.
//
// Use these for an app's UI (see the skill's references/apps.md). Each takes
// `className` to place it; do not restyle its color, height, or radius there.
// Add a control the same way when the app needs one that is not here.

import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TdHTMLAttributes,
  TextareaHTMLAttributes,
  ThHTMLAttributes,
} from 'react'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

const FOCUS = 'outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

const BUTTON_VARIANT = {
  /** The one main action of a view. */
  solid: 'bg-primary text-primary-foreground hover:bg-primary/90',
  outline: 'border-border bg-background hover:bg-muted',
  /** Toolbar and row actions. */
  ghost: 'hover:bg-muted',
  soft: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  danger: 'bg-destructive/10 text-destructive hover:bg-destructive/20',
} as const

const BUTTON_SIZE = {
  md: 'h-8 gap-1.5 px-2.5',
  sm: 'h-7 gap-1 px-2.5',
  xs: 'h-6 gap-1 px-2 text-xs',
  icon: 'size-8',
  'icon-sm': 'size-7',
} as const

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANT
  size?: keyof typeof BUTTON_SIZE
}

export function Button({ variant = 'outline', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-transparent font-medium transition-colors select-none active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
        FOCUS,
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
      {...rest}
    />
  )
}

const FIELD = 'w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(FIELD, FOCUS, 'h-8 py-1', className)} {...rest} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(FIELD, FOCUS, 'min-h-16 py-1.5', className)} {...rest} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx('relative inline-flex min-w-0', className)}>
      <select className={cx(FIELD, FOCUS, 'h-8 appearance-none py-1 pr-8')} {...rest}>
        {children}
      </select>
      <svg aria-hidden="true" viewBox="0 0 16 16" className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

export function Checkbox({ className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <input type="checkbox" className={cx('size-4 shrink-0 rounded-[4px] accent-primary', FOCUS, className)} {...rest} />
}

/** A label over a control, with a hint or an error under it. */
export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('grid gap-1.5', className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  )
}

/** A choice of a few views or modes, in one row. */
export function Segmented<Value extends string>({ options, value, onChange, label, className }: {
  options: ReadonlyArray<{ value: Value; label: ReactNode }>
  value: Value
  onChange(value: Value): void
  /** What the choice is of, for a screen reader. */
  label: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cx('inline-flex h-8 items-center rounded-lg bg-muted p-[3px]', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx('h-full flex-1 rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm', FOCUS)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** The app's own navigation, at the left of its window. Hide it or turn it into a menu in a narrow window. */
export function Sidebar({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <nav className={cx('flex w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-sidebar-border bg-sidebar p-2', className)} {...rest} />
}

export function SidebarLabel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('px-2.5 pt-3 pb-1 text-xs text-muted-foreground first:pt-1', className)} {...rest} />
}

/** One row of a sidebar or a list. `current` marks the open page. */
export function SidebarItem({ current = false, className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { current?: boolean }) {
  return (
    <button
      type={type}
      aria-current={current ? 'page' : undefined}
      className={cx(
        'flex h-8 w-full shrink-0 items-center gap-2 overflow-hidden rounded-lg px-2.5 text-left transition-colors hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium [&_svg]:size-4 [&_svg]:shrink-0 [&>span:last-child]:truncate',
        FOCUS,
        className,
      )}
      {...rest}
    />
  )
}

/** The row above a view: its title at the left, its actions at the right. Not the app's name: Solus shows that. */
export function Toolbar({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('flex h-10 shrink-0 items-center gap-2 border-b border-border px-3', className)} {...rest} />
}

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cx('w-full border-collapse text-left', className)} {...rest} />
}

export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cx('h-9 px-3 text-[10px] font-medium tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase', className)} {...rest} />
}

export function Tr({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cx('border-t border-border transition-colors hover:bg-muted/60', className)} {...rest} />
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cx('px-3 py-2 align-middle', className)} {...rest} />
}

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }) {
  const color = {
    neutral: 'border-border text-muted-foreground',
    accent: 'border-transparent bg-secondary text-secondary-foreground',
    success: 'border-transparent bg-success/10 text-success',
    warning: 'border-transparent bg-warning/10 text-warning',
    danger: 'border-transparent bg-destructive/10 text-destructive',
  }[tone]
  return <span className={cx('inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-xs font-medium whitespace-nowrap', color, className)} {...rest} />
}

/** What a view says when it has nothing to show, and the one thing to do next. */
export function Empty({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center', className)}>
      <p className="m-0 font-medium">{title}</p>
      {children ? <p className="m-0 max-w-[40ch] text-muted-foreground text-pretty">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/** A message in the flow of a view: an error with what to do, or a quiet note. */
export function Notice({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLDivElement> & { tone?: 'neutral' | 'danger' }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cx('rounded-lg border px-3 py-2', tone === 'danger' ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border text-muted-foreground', className)}
      {...rest}
    />
  )
}
