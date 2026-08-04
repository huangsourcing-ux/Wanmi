import type { ReactNode } from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

type FieldControlProps = {
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  id: string
}

export function FormField({
  children,
  className,
  description,
  error,
  hideLabel = false,
  id,
  label,
}: {
  children: (controlProps: FieldControlProps) => ReactNode
  className?: string
  description?: ReactNode
  error?: string
  hideLabel?: boolean
  id: string
  label: string
}) {
  const descriptionId = description ? `${id}-description` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined
  const controlProps: FieldControlProps = {
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
    id,
  }

  return (
    <div className={cn('space-y-2', className)}>
      <Label className={hideLabel ? 'sr-only' : undefined} htmlFor={id}>
        {label}
      </Label>
      {children(controlProps)}
      {description ? (
        <p className="text-sm leading-6 text-muted-foreground" id={descriptionId}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm leading-6 text-destructive" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
