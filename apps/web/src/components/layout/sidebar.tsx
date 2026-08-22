'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAccount } from '@/contexts/account-context'
import type { AccountWithStats } from '@/contexts/account-context'
import { countryFlag } from '@/lib/country-flag'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { menuSections } from './nav-items'
import { Icon } from '@/components/ui/icons'

const appVersion = process.env.APP_VERSION || '0.0.0'
const appCommitSha = process.env.APP_COMMIT_SHA || 'local'
const appBuildTime = process.env.APP_BUILD_TIME || ''
const appBuildDate = appBuildTime ? appBuildTime.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z') : ''

const COLLAPSED_STORAGE_KEY = 'lh_nav_collapsed'

function AccountAvatar({ account, size = 32 }: { account: AccountWithStats; size?: number }) {
  const displayName = account.displayName || account.name
  if (account.pictureUrl) {
    return (
      <img
        src={account.pictureUrl}
        alt={displayName}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold shrink-0 bg-brand-600"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {displayName.charAt(0)}
    </div>
  )
}

function AccountSwitcher() {
  const { accounts, selectedAccount, setSelectedAccountId, loading } = useAccount()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (loading || accounts.length === 0) return null

  const displayName = selectedAccount?.displayName || selectedAccount?.name || ''

  return (
    <div ref={ref} className="px-3 py-3 border-b border-edge">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-surface-alt transition-colors"
      >
        {selectedAccount && <AccountAvatar account={selectedAccount} size={28} />}
        <div className="flex-1 text-left min-w-0">
          <p className="text-sm font-medium text-ink truncate">
            <span className="flex items-center gap-1.5">
              {countryFlag(selectedAccount?.country) && (
                <span className="text-base leading-none">{countryFlag(selectedAccount?.country)}</span>
              )}
              <span>{displayName}</span>
            </span>
          </p>
        </div>
        <svg
          className={`w-4 h-4 text-ink-faint shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-1 bg-surface border border-edge rounded-lg shadow-lg overflow-hidden" role="listbox">
          {accounts.map((account) => {
            const isSelected = account.id === selectedAccount?.id
            const name = account.displayName || account.name
            return (
              <button
                key={account.id}
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  setSelectedAccountId(account.id)
                  setOpen(false)
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                  isSelected ? 'bg-brand-50' : 'hover:bg-surface-alt'
                }`}
              >
                <AccountAvatar account={account} size={24} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm truncate ${isSelected ? 'font-semibold text-brand-700' : 'text-ink-muted'}`}>
                    <span className="flex items-center gap-1.5">
                      {countryFlag(account.country) && (
                        <span className="text-base leading-none">{countryFlag(account.country)}</span>
                      )}
                      <span>{name}</span>
                    </span>
                  </p>
                  {account.basicId && (
                    <p className="text-xs text-ink-faint truncate">{account.basicId}</p>
                  )}
                </div>
                {isSelected && (
                  <svg className="w-4 h-4 text-brand-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function LogoMark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <div
      className={`rounded-lg flex items-center justify-center text-white font-bold bg-brand-600 ${
        size === 'md' ? 'w-8 h-8 text-sm' : 'w-7 h-7 text-xs'
      }`}
    >
      H
    </div>
  )
}

export default function Sidebar() {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const [staffName, setStaffName] = useState<string | null>(null)
  const [staffRole, setStaffRole] = useState<string | null>(null)
  // 折りたたみ状態 (ラベル付きセクションのみ)。既定は全展開、選択はlocalStorageに保存。
  const [collapsed, setCollapsed] = useState<string[]>([])

  useEffect(() => {
    setStaffName(localStorage.getItem('lh_staff_name'))
    setStaffRole(localStorage.getItem('lh_staff_role'))
    try {
      const saved = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) || '[]')
      if (Array.isArray(saved)) setCollapsed(saved.filter((v): v is string => typeof v === 'string'))
    } catch {
      // 壊れた保存値は無視
    }
  }, [])

  const toggleSection = (label: string) => {
    setCollapsed((prev) => {
      const next = prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // storage不可でも動作は継続
      }
      return next
    })
  }

  // 未対応件数 polling — メニュー項目にバッジを出す。5 分間隔。
  // (裏の countUnanswered は messages_log 全走査を含む重い集計なので間隔は詰めない。)
  // チャット画面での status 変更・手動返信直後は UNANSWERED_REFRESH_EVENT で
  // 即時再取得する (ポーリング待ちだと操作してもバッジが減らないと感じるため)。
  const [unansweredCount, setUnansweredCount] = useState<number>(0)
  useEffect(() => {
    let cancelled = false
    // 連続操作で fetch が並走した際、遅い古いレスポンスが新しい値を上書きしない
    // ように発行順 seq でガードする。
    let seq = 0
    const fetchCount = async () => {
      const mySeq = ++seq
      try {
        const { api } = await import('@/lib/api')
        const res = await api.inbox.unanswered.count()
        if (!cancelled && mySeq === seq && res.success) setUnansweredCount(res.data.total)
      } catch {
        // サイレント失敗
      }
    }
    fetchCount()
    const id = setInterval(fetchCount, 5 * 60_000)
    const onRefresh = () => { void fetchCount() }
    window.addEventListener(UNANSWERED_REFRESH_EVENT, onRefresh)
    return () => {
      cancelled = true
      clearInterval(id)
      window.removeEventListener(UNANSWERED_REFRESH_EVENT, onRefresh)
    }
  }, [])

  useEffect(() => { setIsOpen(false) }, [pathname])
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  const isActive = (href: string) => href === '/' ? pathname === '/' : pathname.startsWith(href)

  const sidebarContent = (
    <>
      {/* ロゴ */}
      <div className="px-6 py-5 border-b border-edge">
        <div className="flex items-center gap-2">
          <LogoMark />
          <div>
            <p className="text-sm font-bold text-ink leading-tight">L Harness</p>
            <p className="text-xs text-ink-faint">管理画面</p>
          </div>
        </div>
      </div>

      {/* アカウント切替 */}
      <AccountSwitcher />

      {/* ナビゲーション */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {menuSections.map((section, si) => {
          // アクティブなページを含むセクションは折りたたみ状態でも開く (迷子防止)
          const containsActive = section.items.some((item) => isActive(item.href))
          const isCollapsed =
            section.label !== null && collapsed.includes(section.label) && !containsActive
          return (
            <div key={si}>
              {section.label && (
                <button
                  onClick={() => toggleSection(section.label!)}
                  aria-expanded={!isCollapsed}
                  className="w-full flex items-center justify-between pt-5 pb-2 px-3 group"
                >
                  <p className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider group-hover:text-ink-muted">
                    {section.label}
                  </p>
                  <svg
                    className={`w-3.5 h-3.5 text-ink-faint transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              )}
              {!isCollapsed && section.items.filter((item) => {
                if (item.href === '/staff' && staffRole !== 'owner') return false
                if (item.href === '/security' && staffRole !== 'owner') return false
                if (item.href === '/accounts' && staffRole === 'staff') return false
                return true
              }).map((item) => {
                const active = isActive(item.href)
                const isDanger = item.danger === true
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? isDanger
                          ? 'bg-danger text-white'
                          : 'bg-brand-600 text-white'
                        : isDanger
                          ? 'text-red-500 hover:bg-red-50'
                          : 'text-ink-muted hover:bg-surface-alt hover:text-ink'
                    }`}
                  >
                    <Icon name={item.icon} />
                    <span className="flex-1">{item.label}</span>
                    {item.href === '/notifications' && unansweredCount > 0 && (
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
                          active ? 'bg-white text-rose-600' : 'bg-rose-500 text-white'
                        }`}
                      >
                        {unansweredCount > 99 ? '99+' : unansweredCount}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          )
        })}
      </nav>

      {/* フッター */}
      <div className="border-t border-edge">
        {staffName && (
          <div className="px-3 py-2 text-xs text-ink-muted border-t border-surface-alt">
            <div className="font-medium text-ink">{staffName}</div>
            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mt-0.5 ${
              staffRole === 'owner' ? 'bg-amber-100 text-amber-800' :
              staffRole === 'admin' ? 'bg-brand-100 text-brand-800' :
              'bg-gray-100 text-gray-600'
            }`}>
              {staffRole === 'owner' ? 'オーナー' : staffRole === 'admin' ? '管理者' : 'スタッフ'}
            </span>
          </div>
        )}
        <div className="px-6 py-4 space-y-3">
        <div className="space-y-0.5">
          <p className="text-xs text-ink-faint">L Harness v{appVersion}</p>
          <p className="text-[10px] text-ink-faint font-mono break-all">
            build {appCommitSha}{appBuildDate ? ` · ${appBuildDate}` : ''}
          </p>
        </div>
        <button
          onClick={async () => {
            try {
              const apiUrl = process.env.NEXT_PUBLIC_API_URL
              if (apiUrl) {
                await fetch(`${apiUrl}/api/auth/logout`, {
                  method: 'POST',
                  credentials: 'include',
                })
              }
            } catch {
              // Local cleanup still logs the browser out if the network call fails.
            }
            localStorage.removeItem('lh_api_key')
            localStorage.removeItem('lh_csrf')
            localStorage.removeItem('lh_staff_name')
            localStorage.removeItem('lh_staff_role')
            window.location.href = '/login'
          }}
          className="flex items-center gap-2 text-xs text-ink-faint hover:text-red-500 transition-colors"
        >
          <Icon name="logout" className="w-4 h-4" />
          ログアウト
        </button>
        </div>
      </div>
    </>
  )

  return (
    <>
      {/* モバイル: ハンバーガーヘッダー */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-50 bg-surface border-b border-edge px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-surface-alt transition-colors"
          aria-label="メニュー"
          aria-expanded={isOpen}
        >
          <svg className="w-6 h-6 text-ink" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {isOpen
              ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            }
          </svg>
        </button>
        <div className="flex items-center gap-2">
          <LogoMark size="sm" />
          <p className="text-sm font-bold text-ink">L Harness</p>
        </div>
      </div>

      {/* モバイル: オーバーレイ */}
      {isOpen && <div className="lg:hidden fixed inset-0 z-40 bg-black/50" onClick={() => setIsOpen(false)} />}

      {/* モバイル: スライドインサイドバー */}
      <aside className={`lg:hidden fixed top-0 left-0 z-50 w-72 bg-surface flex flex-col h-screen transform transition-transform duration-300 ease-in-out ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="absolute top-4 right-4">
          <button onClick={() => setIsOpen(false)} className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-surface-alt" aria-label="閉じる">
            <svg className="w-5 h-5 text-ink-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {sidebarContent}
      </aside>

      {/* デスクトップ: 常時表示 */}
      <aside className="hidden lg:flex w-64 bg-surface border-r border-edge flex-col h-screen sticky top-0">
        {sidebarContent}
      </aside>
    </>
  )
}
