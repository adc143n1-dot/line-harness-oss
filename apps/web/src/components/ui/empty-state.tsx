import type { ReactNode } from 'react'

export interface EmptyStateProps {
  /** 中央に表示するアイコン (SVG要素)。省略時は既定のトレイアイコン */
  icon?: ReactNode
  title: string
  description?: string
  /** 「次にやること」ボタン等 */
  action?: ReactNode
  className?: string
}

// 「〜がありません」1行表示の置換先。何が空で、次に何をすればよいかを伝える。
export default function EmptyState({ icon, title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center text-center px-6 py-12 ${className}`}>
      <div className="w-12 h-12 mb-3 flex items-center justify-center rounded-full bg-surface-alt text-ink-faint">
        {icon ?? (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.8}
              d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-5.5a1 1 0 00-.8.4l-.9 1.2a1 1 0 01-.8.4h-2a1 1 0 01-.8-.4l-.9-1.2a1 1 0 00-.8-.4H4"
            />
          </svg>
        )}
      </div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 text-sm text-ink-muted max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
