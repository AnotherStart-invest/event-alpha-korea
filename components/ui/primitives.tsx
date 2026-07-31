import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/shared/cn';

/* ── Card ─────────────────────────────────────────────── */

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-4 pt-4 pb-2', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return <h3 className={cn('text-base font-semibold leading-snug', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-4 pb-4', className)} {...props} />;
}

/* ── Button ───────────────────────────────────────────── */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium ' +
    'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
    'disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-foreground text-white hover:bg-foreground/85',
        outline: 'border border-border-strong bg-background hover:bg-surface-muted',
        ghost: 'hover:bg-surface-muted',
        positive: 'bg-positive text-white hover:bg-positive/90',
        negative: 'bg-negative text-white hover:bg-negative/90',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        default: 'h-9 px-3.5',
        lg: 'h-10 px-5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

/* ── Badge ────────────────────────────────────────────── */

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none',
  {
    variants: {
      tone: {
        neutral: 'border-border-strong bg-neutral-bg text-neutral',
        positive: 'border-positive/25 bg-positive-bg text-positive',
        negative: 'border-negative/25 bg-negative-bg text-negative',
        warn: 'border-warn/25 bg-warn-bg text-warn',
        outline: 'border-border-strong bg-background text-muted-strong',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/* ── Table ────────────────────────────────────────────── */

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="scroll-x rounded-lg border border-border">
      <table className={cn('w-full min-w-[52rem] text-sm', className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'border-b border-border bg-surface-muted px-2.5 py-2 text-left text-xs font-semibold text-muted-strong',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td className={cn('border-b border-border px-2.5 py-2 align-top', className)} {...props} />
  );
}

/* ── Misc ─────────────────────────────────────────────── */

export function Separator({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('h-px w-full bg-border', className)} role="separator" {...props} />;
}

export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded bg-surface-muted', className)} {...props} />;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong px-6 py-12 text-center">
      <p className="text-sm font-medium text-muted-strong">{title}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function SectionTitle({
  index,
  children,
  hint,
}: {
  index?: number;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      {index !== undefined ? (
        <span className="tnum text-xs font-semibold text-muted">{String(index).padStart(2, '0')}</span>
      ) : null}
      <h2 className="text-sm font-semibold tracking-tight">{children}</h2>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  );
}
