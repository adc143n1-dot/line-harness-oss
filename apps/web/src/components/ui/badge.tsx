import type { HTMLAttributes } from 'react'

export type BadgeTone =
  | 'gray'
  | 'blue'
  | 'green'
  | 'amber'
  | 'red'
  | 'violet'
  | 'orange'
  | 'sky'

const TONE_CLASSES: Record<BadgeTone, string> = {
  gray: 'bg-gray-100 text-gray-600',
  blue: 'bg-brand-100 text-brand-700',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  violet: 'bg-violet-50 text-violet-700',
  orange: 'bg-orange-50 text-orange-700',
  sky: 'bg-sky-50 text-sky-700',
}

// ステータス表示の標準バッジ。絵文字ステータス (🔥HOT 等) の置換先。
export default function Badge({
  tone = 'gray',
  className = '',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`}
      {...props}
    />
  )
}
