'use client'

import { useMemo, useState } from 'react'
import Header from '@/components/layout/header'
import { GUIDE_GROUPS, type Callout, type ScreenBadge } from '@/data/guide-content'

const BADGE_STYLE: Record<ScreenBadge, { label: string; className: string }> = {
  new: { label: 'NEW', className: 'bg-green-100 text-green-700' },
  owner: { label: 'オーナー限定', className: 'bg-yellow-100 text-yellow-800' },
  admin: { label: '管理者以上', className: 'bg-blue-100 text-blue-800' },
  danger: { label: '危険操作', className: 'bg-red-100 text-red-700' },
}

const CALLOUT_STYLE: Record<Callout['kind'], string> = {
  info: 'bg-gray-50 border-gray-200 text-gray-600',
  caution: 'bg-amber-50 border-amber-200 text-amber-700',
  danger: 'bg-red-50 border-red-200 text-red-700',
}

function ScreenBadgePill({ badge }: { badge: ScreenBadge }) {
  const style = BADGE_STYLE[badge]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${style.className}`}>
      {style.label}
    </span>
  )
}

export default function GuidePage() {
  const [query, setQuery] = useState('')

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return GUIDE_GROUPS
    return GUIDE_GROUPS
      .map((group) => ({
        ...group,
        screens: group.screens.filter((s) => s.title.toLowerCase().includes(q) || s.purpose.toLowerCase().includes(q)),
      }))
      .filter((group) => group.screens.length > 0)
  }, [query])

  return (
    <div className="space-y-8">
      <Header
        title="運用ガイド"
        description="L Harness 管理画面の全画面を、機能・操作・注意点でまとめたリファレンスです。"
        action={
          <a
            href="/staff-guide.html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-gray-300 hover:bg-gray-50 whitespace-nowrap"
          >
            スタッフに共有用リンクを開く ↗
          </a>
        }
      />

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <p className="text-xs text-gray-500 mb-3">
          共有用リンク（ログイン不要・そのままURLをスタッフに送れます）:{' '}
          <code className="text-[11px] bg-gray-100 px-1.5 py-0.5 rounded">/staff-guide.html</code>
        </p>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="画面名やキーワードで検索…"
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-green-500"
        />
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs text-gray-500">
          <span className="inline-flex items-center gap-1.5"><ScreenBadgePill badge="new" />今回追加された新機能</span>
          <span className="inline-flex items-center gap-1.5"><ScreenBadgePill badge="owner" />オーナー権限でしか開けない</span>
          <span className="inline-flex items-center gap-1.5"><ScreenBadgePill badge="admin" />スタッフには表示されない</span>
          <span className="inline-flex items-center gap-1.5"><ScreenBadgePill badge="danger" />影響が大きい・取り消せない操作を含む</span>
        </div>
      </div>

      {filteredGroups.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
          「{query}」に一致する画面がありません
        </div>
      ) : (
        filteredGroups.map((group) => (
          <section key={group.key} className="space-y-3">
            <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider pt-2">{group.label}</h2>

            {group.screens.map((screen) => (
              <article key={screen.id} className="rounded-lg border border-gray-200 bg-white p-5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <h3 className="text-sm font-bold text-gray-900">{screen.title}</h3>
                  {screen.badges && screen.badges.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap">
                      {screen.badges.map((b) => <ScreenBadgePill key={b} badge={b} />)}
                    </div>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1.5">{screen.purpose}</p>

                {screen.blocks && screen.blocks.length > 0 && (
                  <div className="mt-3 space-y-3">
                    {screen.blocks.map((block, i) => (
                      <div key={i}>
                        {block.label && (
                          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1.5">{block.label}</p>
                        )}
                        <ul className="list-disc list-outside pl-4 space-y-1 text-xs text-gray-700">
                          {block.items.map((item, j) => <li key={j}>{item}</li>)}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}

                {screen.callouts && screen.callouts.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {screen.callouts.map((c, i) => (
                      <div key={i} className={`rounded-lg border p-3 text-xs leading-relaxed ${CALLOUT_STYLE[c.kind]}`}>
                        {c.text}
                      </div>
                    ))}
                  </div>
                )}

                {screen.flow && screen.flow.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
                    {screen.flow.map((step, i) => (
                      <span key={i} className="inline-flex items-center gap-1.5">
                        <span className="bg-gray-100 text-gray-700 px-2 py-1 rounded-md whitespace-nowrap">{step}</span>
                        {i < screen.flow!.length - 1 && <span className="text-gray-300">→</span>}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </section>
        ))
      )}
    </div>
  )
}
