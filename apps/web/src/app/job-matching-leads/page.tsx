'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { JobMatchingLeadItem } from '@/lib/api'
import Header from '@/components/layout/header'

const PAGE_SIZE = 30

const Q1_LABELS: Record<string, string> = {
  fulltime: '本業レベルでしっかり稼ぎたい',
  weekly: '週に1,2回',
  gap_time: 'すきま時間だけ',
  consult_only: 'まずは相談だけ',
}
const Q2_LABELS: Record<string, string> = {
  high_value: '高額案件',
  sns_management: 'SNS運用',
  registered_gig: '登録案件',
  single_gig: '単発案件',
  other: 'その他',
}
const Q3_LABELS: Record<string, string> = {
  weekday_day: '平日の日中',
  weekday_night: '平日の夜',
  weekend: '週末のみ',
  anytime: 'いつでも',
}
const Q4_LABELS: Record<string, string> = {
  now: '今すぐ',
  within_month: '1ヶ月以内',
  researching: '情報収集中',
}
const STATE_LABELS: Record<string, string> = {
  awaiting_q1: 'Q1回答待ち',
  awaiting_q2: 'Q2回答待ち',
  diagnosed: '診断完了',
}
const TEMPERATURE_STYLE: Record<string, { label: string; className: string }> = {
  hot: { label: '🔥 HOT', className: 'bg-red-100 text-red-700' },
  warm: { label: '🌤️ WARM', className: 'bg-yellow-100 text-yellow-800' },
  cold: { label: '❄️ COLD', className: 'bg-blue-100 text-blue-700' },
}

const CHAT_STATUS_LABELS: Record<string, string> = {
  unread: '未読',
  in_progress: '対応中',
  waiting_reply: '返信待ち',
  resolved: '対応済み',
}

export default function JobMatchingLeadsPage() {
  const [items, setItems] = useState<JobMatchingLeadItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  // チーム状況ページの「HOT未割当」カードから ?temperature=hot で遷移してくる
  const [temperature, setTemperature] = useState<'' | 'hot' | 'warm' | 'cold'>(() => {
    if (typeof window === 'undefined') return ''
    const t = new URLSearchParams(window.location.search).get('temperature')
    return t === 'hot' || t === 'warm' || t === 'cold' ? t : ''
  })
  const [searchInput, setSearchInput] = useState('')
  const [searchSubmitted, setSearchSubmitted] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 担当列の名前解決用
  const [staffRoster, setStaffRoster] = useState<{ id: string; name: string; isActive: boolean }[]>([])

  useEffect(() => {
    api.staff.roster().then((res) => {
      if (res.success) setStaffRoster(res.data)
    }).catch(() => {})
  }, [])

  const staffNameOf = (id: string | null) =>
    id ? (staffRoster.find((s) => s.id === id)?.name ?? '不明なスタッフ') : null

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.jobMatchingLeads.list({
        offset: String((page - 1) * PAGE_SIZE),
        limit: PAGE_SIZE,
        temperature: temperature || undefined,
        search: searchSubmitted || undefined,
      })
      if (res.success) {
        setItems(res.data.items)
        setTotal(res.data.total)
      } else {
        setError(res.error)
      }
    } catch {
      setError('読み込みに失敗しました')
    }
    setLoading(false)
  }, [page, temperature, searchSubmitted])

  useEffect(() => { load() }, [load])

  const updateAndResetPage = (cb: () => void) => {
    cb()
    setPage(1)
  }

  const hasNextPage = page * PAGE_SIZE < total

  return (
    <div>
      <Header
        title="副業マッチングリード"
        description="LINE上でQ1/Q2診断を受けた友だちの一覧。スコアが高い順に表示されます。"
      />

      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <div className="flex flex-wrap gap-3">
          <form
            onSubmit={(e) => { e.preventDefault(); updateAndResetPage(() => setSearchSubmitted(searchInput)) }}
            className="flex gap-2"
          >
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="名前で検索..."
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-48"
            />
            <button
              type="submit"
              className="px-3 py-2 min-h-[44px] rounded-lg text-white text-sm font-medium"
              style={{ backgroundColor: '#06C755' }}
            >
              検索
            </button>
          </form>
          <select
            value={temperature}
            onChange={(e) => updateAndResetPage(() => setTemperature(e.target.value as typeof temperature))}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">すべての温度</option>
            <option value="hot">🔥 HOT</option>
            <option value="warm">🌤️ WARM</option>
            <option value="cold">❄️ COLD</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">{error}</div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">読み込み中...</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          該当するリードがまだありません
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">名前</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Q1</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Q2</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">時間帯</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">開始時期</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">スコア</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状態</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">担当</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">対応状況</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">更新日時</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {items.map((lead) => {
                const temp = lead.leadTemperature ? TEMPERATURE_STYLE[lead.leadTemperature] : null
                return (
                  <tr key={lead.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{lead.displayName || '(名前なし)'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{lead.q1Answer ? Q1_LABELS[lead.q1Answer] ?? lead.q1Answer : '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{lead.q2Answer ? Q2_LABELS[lead.q2Answer] ?? lead.q2Answer : '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{lead.q3Answer ? Q3_LABELS[lead.q3Answer] ?? lead.q3Answer : '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {lead.q4Answer ? (
                        lead.q4Answer === 'now'
                          ? <span className="text-xs px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 font-medium">🚀 今すぐ</span>
                          : (Q4_LABELS[lead.q4Answer] ?? lead.q4Answer)
                      ) : '-'}
                    </td>
                    <td className="px-4 py-3">
                      {lead.leadScore !== null && temp ? (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${temp.className}`}>
                          {temp.label} {lead.leadScore}点
                        </span>
                      ) : (
                        <span className="text-sm text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {lead.conversationState ? STATE_LABELS[lead.conversationState] ?? lead.conversationState : '-'}
                    </td>
                    <td className="px-4 py-3">
                      {lead.operatorId ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                          🙋 {staffNameOf(lead.operatorId)}
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">未割当</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {lead.chatStatus ? CHAT_STATUS_LABELS[lead.chatStatus] ?? lead.chatStatus : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {new Date(lead.updatedAt).toLocaleString('ja-JP')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && total > 0 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-gray-500">全 {total} 件中 {(page - 1) * PAGE_SIZE + 1}〜{Math.min(page * PAGE_SIZE, total)} 件</p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              前へ
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNextPage}
              className="px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              次へ
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
