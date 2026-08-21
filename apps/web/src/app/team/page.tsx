'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { api } from '@/lib/api'
import type { TeamOverview } from '@/lib/api'

const POLL_INTERVAL_MS = 30_000

export default function TeamPage() {
  const [overview, setOverview] = useState<TeamOverview | null>(null)
  const [staffRoster, setStaffRoster] = useState<{ id: string; name: string; isActive: boolean }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await api.team.overview()
      if (res.success) {
        setOverview(res.data)
        setError('')
      } else {
        setError('取得に失敗しました')
      }
    } catch {
      setError('取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    api.staff.roster().then((res) => {
      if (res.success) setStaffRoster(res.data)
    }).catch(() => {})
    const id = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [load])

  const nameOf = (id: string) => staffRoster.find((s) => s.id === id)?.name ?? '不明なスタッフ'

  // 名簿にいる全アクティブスタッフを表示する (0件のスタッフも「手が空いている」
  // という情報なので行として出す)。overview 側にしかいない operator (無効化済み等)
  // も末尾に出す。
  const staffRows = (() => {
    if (!overview) return []
    const byId = new Map(overview.staff.map((s) => [s.operatorId, s]))
    const rows: Array<{ operatorId: string; name: string } & TeamOverview['staff'][number]> = []
    for (const s of staffRoster.filter((s) => s.isActive)) {
      const stats = byId.get(s.id) ?? {
        operatorId: s.id, unread: 0, inProgress: 0, waitingReply: 0, resolvedToday: 0, avgFirstResponseMinutes: null,
      }
      rows.push({ ...stats, operatorId: s.id, name: s.name })
      byId.delete(s.id)
    }
    for (const [operatorId, stats] of byId) {
      rows.push({ ...stats, operatorId, name: nameOf(operatorId) })
    }
    // 抱えている未完了合計が多い順
    rows.sort((a, b) => (b.unread + b.inProgress + b.waitingReply) - (a.unread + a.inProgress + a.waitingReply))
    return rows
  })()

  return (
    <div>
      <Header
        title="チーム状況"
        description="スタッフごとの担当件数と、未割当バックログの一覧。30秒ごとに自動更新されます。"
      />

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 mb-4">{error}</div>
      )}

      {/* グローバルKPI */}
      {overview && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <Link
            href="/notifications"
            className="bg-white rounded-lg border border-gray-200 p-4 hover:bg-gray-50 transition-colors"
          >
            <p className="text-xs text-gray-500">未対応の合計</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{overview.global.totalUnanswered}<span className="text-sm font-normal text-gray-400 ml-1">件</span></p>
          </Link>
          <Link
            href="/chats?operator=none"
            className={`rounded-lg border p-4 transition-colors ${
              overview.global.unassignedBacklog > 0
                ? 'bg-amber-50 border-amber-200 hover:bg-amber-100'
                : 'bg-white border-gray-200 hover:bg-gray-50'
            }`}
            title="チャット一覧で「担当: 未割当のみ」に絞って確認できます"
          >
            <p className="text-xs text-gray-500">未割当バックログ (誰も持っていない未対応)</p>
            <p className={`text-2xl font-bold mt-1 ${overview.global.unassignedBacklog > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
              {overview.global.unassignedBacklog}<span className="text-sm font-normal text-gray-400 ml-1">件</span>
            </p>
          </Link>
          <Link
            href="/job-matching-leads?temperature=hot"
            className={`rounded-lg border p-4 transition-colors ${
              overview.global.hotUnassigned > 0
                ? 'bg-red-50 border-red-200 hover:bg-red-100'
                : 'bg-white border-gray-200 hover:bg-gray-50'
            }`}
          >
            <p className="text-xs text-gray-500">🔥 HOTリードで未割当</p>
            <p className={`text-2xl font-bold mt-1 ${overview.global.hotUnassigned > 0 ? 'text-red-700' : 'text-gray-900'}`}>
              {overview.global.hotUnassigned}<span className="text-sm font-normal text-gray-400 ml-1">件</span>
            </p>
          </Link>
        </div>
      )}

      {/* スタッフ別テーブル */}
      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">読み込み中...</div>
      ) : staffRows.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          スタッフが登録されていません (「スタッフ管理」から追加できます)
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">スタッフ</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">未読</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">対応中</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">返信待ち</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">本日解決</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase" title="直近7日、担当が付いてから最初の返信までの平均">平均初動</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {staffRows.map((row) => (
                <tr key={row.operatorId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    <Link
                      href={`/chats?operator=${encodeURIComponent(row.operatorId)}`}
                      className="hover:underline"
                      title="このスタッフの担当チャットを一覧で見る"
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums">
                    {row.unread > 0 ? <span className="font-semibold text-red-600">{row.unread}</span> : <span className="text-gray-400">0</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums text-gray-900">{row.inProgress}</td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums text-gray-600">{row.waitingReply}</td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums text-emerald-700">{row.resolvedToday}</td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums text-gray-600">
                    {row.avgFirstResponseMinutes === null
                      ? <span className="text-gray-300">—</span>
                      : row.avgFirstResponseMinutes < 60
                        ? `${row.avgFirstResponseMinutes}分`
                        : `${Math.round(row.avgFirstResponseMinutes / 6) / 10}時間`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
