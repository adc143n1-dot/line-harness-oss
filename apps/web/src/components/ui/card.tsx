import type { HTMLAttributes } from 'react'

// カードの標準様式。padding は用途で変わるため呼び出し側で付ける (デフォルト p-4)。
export default function Card({
  className = '',
  padded = true,
  ...props
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return (
    <div
      className={`bg-surface rounded-lg border border-edge shadow-sm ${padded ? 'p-4' : ''} ${className}`}
      {...props}
    />
  )
}
