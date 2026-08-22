'use client'

import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'line' | 'ghost'
export type ButtonSize = 'sm' | 'md'

// line variant はLINE操作 (LINEで開く・友だち追加など) 専用。それ以外の主要操作は primary (青)。
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300',
  secondary: 'bg-surface text-ink border border-edge hover:bg-surface-alt disabled:text-ink-faint',
  danger: 'bg-danger text-white hover:bg-red-700 disabled:bg-red-300',
  line: 'bg-line text-white hover:bg-line-dark disabled:opacity-50',
  ghost: 'text-ink-muted hover:bg-surface-alt hover:text-ink disabled:text-ink-faint',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm min-h-[36px]',
  md: 'px-4 py-2 text-sm min-h-[44px]',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className = '', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...props}
    />
  )
})

export default Button
