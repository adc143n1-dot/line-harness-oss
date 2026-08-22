export function Spinner({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      className={`animate-spin text-brand-600 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="読み込み中"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

// ページ/カード単位の読み込み表示 (「読み込み中...」テキストの置換先)
export function LoadingState({ label = '読み込み中…', className = '' }: { label?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center gap-2 py-12 text-sm text-ink-muted ${className}`}>
      <Spinner className="w-4 h-4" />
      {label}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-surface-alt ${className}`} aria-hidden="true" />
}
