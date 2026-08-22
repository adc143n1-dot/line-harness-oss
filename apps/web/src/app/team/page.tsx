'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { Icon } from '@/components/ui/icons'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { api } from '@/lib/api'
import type { TeamOverview, AdvisorReport, AutomationCandidate } from '@/lib/api'

const POLL_INTERVAL_MS = 30_000

const CANDIDATE_TYPE_LABEL: Record<AutomationCandidate['type'], string> = {
  repeated_manual_reply: '手動で繰り返し送信 → テンプレート化の候補',
  frequent_incoming: '同じ質問が繰り返し届く → 自動返信の候補',
}

export default function TeamPage() {
  const { confirm: confirmDialog } = useConfirm()
  const [overview, setOverview] = useState<TeamOverview | null>(null)
  const [staffRoster, setStaffRoster] = useState<{ id: string; name: string; isActive: boolean }[]>([])
  const [myRole, setMyRole] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // AIアドバイザー
  const [report, setReport] = useState<AdvisorReport | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [advisorError, setAdvisorError] = useState('')
  const [candidates, setCandidates] = useState<AutomationCandidate[]>([])
  const [showCandidates, setShowCandidates] = useState(false)
  // SLA目標の編集
  const [editingTargets, setEditingTargets] = useState(false)
  const [targetFirstResponse, setTargetFirstResponse] = useState('')
  const [targetDailyResolved, setTargetDailyResolved] = useState('')

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
    api.staff.roster().then((res) => { if (res.success) setStaffRoster(res.data) }).catch(() => {})
    api.staff.me().then((res) => setMyRole(res.success ? res.data.role : null)).catch(() => setMyRole(null))
    api.advisor.report().then((res) => { if (res.success) setReport(res.data) }).catch(() => {})
    api.advisor.automationCandidates().then((res) => { if (res.success) setCandidates(res.data) }).catch(() => {})
    const id = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [load])

  const handleAnalyze = async () => {
    if (!(await confirmDialog({ title: 'AI分析', message: 'AI分析を実行しますか？(Anthropic APIを1回呼び出します)', confirmLabel: '実行する' }))) return
    setAnalyzing(true)
    setAdvisorError('')
    try {
      const res = await api.advisor.analyze()
      if (res.success) setReport(res.data)
      else setAdvisorError(res.error)
    } catch {
      setAdvisorError('AI分析に失敗しました。ANTHROPIC_API_KEY の設定を確認してください。')
    } finally {
      setAnalyzing(false)
    }
  }

  const handleSaveTargets = async () => {
    try {
      await api.team.setTargets({
        firstResponseMinutes: targetFirstResponse === '' ? null : Number(targetFirstResponse),
        dailyResolved: targetDailyResolved === '' ? null : Number(targetDailyResolved),
      })
      setEditingTargets(false)
      void load()
    } catch {
      setError('目標の保存に失敗しました (admin/owner のみ設定できます)')
    }
  }

  const nameOf = (id: string) => staffRoster.find((s) => s.id === id)?.name ?? '不明なスタッフ'

  const staffRows = (() => {
    if (!overview) return []
    const byId = new Map(overview.staff.map((s) => [s.operatorId, s]))
    const rows: Array<{ operatorId: string; name: string } & TeamOverview['staff'][number]> = []
    for (const s of staffRoster.filter((s) => s.isActive)) {
      const stats = byId.get(s.id) ?? {
        operatorId: s.id, unread: 0, inProgress: 0, waitingReply: 0,
        resolvedToday: 0, avgFirstResponseMinutes: null, resolved30d: 0, converted30d: 0,
      }
      rows.push({ ...stats, operatorId: s.id, name: s.name })
      byId.delete(s.id)
    }
    for (const [operatorId, stats] of byId) {
      rows.push({ ...stats, operatorId, name: nameOf(operatorId) })
    }
    rows.sort((a, b) => (b.unread + b.inProgress + b.waitingReply) - (a.unread + a.inProgress + a.waitingReply))
    return rows
  })()

  const targets = overview?.targets
  const totalResolvedToday = staffRows.reduce((sum, r) => sum + r.resolvedToday, 0)
  const trendMax = Math.max(1, ...(overview?.trend.map((t) => t.cnt) ?? [1]))

  // 目標との比較で初動時間セルを色分け
  const firstResponseClass = (min: number | null) => {
    if (min === null) return 'text-gray-300'
    if (targets?.firstResponseMinutes != null) {
      return min <= targets.firstResponseMinutes ? 'text-emerald-700' : 'text-red-600 font-semibold'
    }
    return 'text-gray-600'
  }

  return (
    <div>
      <Header
        title="チーム状況"
        description="スタッフごとの担当件数と、未割当バックログの一覧。30秒ごとに自動更新されます。"
        action={
          <button
            onClick={() => { void handleAnalyze() }}
            disabled={analyzing}
            className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-lg text-white text-sm font-medium disabled:opacity-50 bg-violet-600 hover:bg-violet-700"
            title="運用データをAIが分析し、改善・自動化の提案を返します"
          >
            <Icon name="sparkles" className="w-4 h-4" />
            {analyzing ? '分析中…' : 'AIで分析'}
          </button>
        }
      />

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 mb-4">{error}</div>
      )}

      {/* AI所見 */}
      {(report || advisorError) && (
        <div className="bg-white rounded-lg border border-violet-200 p-5 mb-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-violet-800 inline-flex items-center gap-1.5"><Icon name="sparkles" className="w-4 h-4" /> AI所見</h2>
            {report && (
              <span className="text-xs text-gray-400">
                {new Date(report.generatedAt).toLocaleString('ja-JP')} 生成
                {report.trigger === 'weekly' ? ' (週次自動)' : ''}
              </span>
            )}
          </div>
          {advisorError ? (
            <p className="text-sm text-red-600">{advisorError}</p>
          ) : (
            <div className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{report?.content}</div>
          )}
        </div>
      )}

      {/* 自動化候補 (ルールベース・無料) */}
      {candidates.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
          <button
            onClick={() => setShowCandidates((v) => !v)}
            className="w-full flex items-center justify-between text-left"
          >
            <h2 className="text-sm font-bold text-gray-800 inline-flex items-center gap-1.5"><Icon name="bolt" className="w-4 h-4 text-ink-muted" /> 自動化の候補 ({candidates.length}件)</h2>
            <span className="text-xs text-gray-400">{showCandidates ? '閉じる ▲' : '開く ▼'}</span>
          </button>
          {showCandidates && (
            <ul className="mt-3 space-y-2">
              {candidates.map((cand, i) => (
                <li key={i} className="text-sm border border-gray-100 rounded-lg p-3 bg-gray-50">
                  <p className="text-xs text-gray-500 mb-1">{CANDIDATE_TYPE_LABEL[cand.type]} ({cand.count}回)</p>
                  <p className="text-gray-800 whitespace-pre-wrap">{cand.content.slice(0, 200)}</p>
                  <div className="mt-2 flex gap-2">
                    {cand.type === 'repeated_manual_reply' ? (
                      <Link href="/templates" className="text-xs text-brand-700 hover:underline">→ テンプレートに登録する</Link>
                    ) : (
                      <Link href="/auto-replies" className="text-xs text-brand-700 hover:underline">→ 自動返信ルールを作る</Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
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
            <p className="text-xs text-gray-500 inline-flex items-center gap-1"><Icon name="fire" className="w-3.5 h-3.5 text-red-500" /> HOTリードで未割当</p>
            <p className={`text-2xl font-bold mt-1 ${overview.global.hotUnassigned > 0 ? 'text-red-700' : 'text-gray-900'}`}>
              {overview.global.hotUnassigned}<span className="text-sm font-normal text-gray-400 ml-1">件</span>
            </p>
          </Link>
        </div>
      )}

      {/* SLA目標 + 14日トレンド */}
      {overview && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold text-gray-500 uppercase">SLA目標</h3>
              {(myRole === 'owner' || myRole === 'admin') && !editingTargets && (
                <button
                  onClick={() => {
                    setTargetFirstResponse(targets?.firstResponseMinutes?.toString() ?? '')
                    setTargetDailyResolved(targets?.dailyResolved?.toString() ?? '')
                    setEditingTargets(true)
                  }}
                  className="text-xs text-gray-400 hover:text-gray-600 underline"
                >
                  編集
                </button>
              )}
            </div>
            {editingTargets ? (
              <div className="space-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <span className="w-28 text-xs text-gray-500">目標初動 (分)</span>
                  <input type="number" value={targetFirstResponse} onChange={(e) => setTargetFirstResponse(e.target.value)}
                    placeholder="例: 30 (空欄で解除)" className="border border-edge rounded-lg px-2 py-1 text-sm w-36" />
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-28 text-xs text-gray-500">日次解決目標 (件)</span>
                  <input type="number" value={targetDailyResolved} onChange={(e) => setTargetDailyResolved(e.target.value)}
                    placeholder="例: 20 (空欄で解除)" className="border border-edge rounded-lg px-2 py-1 text-sm w-36" />
                </label>
                <div className="flex gap-2 pt-1">
                  <button onClick={() => { void handleSaveTargets() }} className="px-3 py-1 text-xs text-white rounded-lg bg-brand-600 hover:bg-brand-700">保存</button>
                  <button onClick={() => setEditingTargets(false)} className="px-3 py-1 text-xs border border-edge rounded-lg">キャンセル</button>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5 text-sm">
                <p className="flex items-center justify-between">
                  <span className="text-gray-500">平均初動の目標</span>
                  <span className="font-medium">{targets?.firstResponseMinutes != null ? `${targets.firstResponseMinutes}分以内` : <span className="text-gray-300">未設定</span>}</span>
                </p>
                <p className="flex items-center justify-between">
                  <span className="text-gray-500">本日の解決 / 目標</span>
                  <span className={`font-medium tabular-nums ${
                    targets?.dailyResolved != null
                      ? totalResolvedToday >= targets.dailyResolved ? 'text-emerald-700' : 'text-amber-700'
                      : ''
                  }`}>
                    {totalResolvedToday}{targets?.dailyResolved != null ? ` / ${targets.dailyResolved}件` : '件'}
                  </span>
                </p>
              </div>
            )}
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="text-xs font-bold text-gray-500 uppercase mb-2">解決数の推移 (14日)</h3>
            {overview.trend.length === 0 ? (
              <p className="text-sm text-gray-300 py-4 text-center">まだデータがありません</p>
            ) : (
              <div className="flex items-end gap-1 h-20">
                {overview.trend.map((t) => (
                  <div key={t.day} className="flex-1 flex flex-col items-center gap-0.5" title={`${t.day}: ${t.cnt}件`}>
                    <span className="text-[9px] text-gray-400 tabular-nums">{t.cnt}</span>
                    <div
                      className="w-full rounded-t bg-emerald-400"
                      style={{ height: `${Math.max(4, (t.cnt / trendMax) * 56)}px` }}
                    />
                    <span className="text-[8px] text-gray-300">{t.day.slice(5).replace('-', '/')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
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
          <table className="w-full min-w-[840px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">スタッフ</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">未読</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">対応中</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">返信待ち</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">本日解決</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase" title="直近7日、担当が付いてから最初の返信までの平均">平均初動</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase" title="直近30日の解決のうち成約になった割合">成約率(30日)</th>
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
                  <td className={`px-4 py-3 text-sm text-right tabular-nums ${firstResponseClass(row.avgFirstResponseMinutes)}`}>
                    {row.avgFirstResponseMinutes === null
                      ? '—'
                      : row.avgFirstResponseMinutes < 60
                        ? `${row.avgFirstResponseMinutes}分`
                        : `${Math.round(row.avgFirstResponseMinutes / 6) / 10}時間`}
                  </td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums text-gray-700">
                    {row.resolved30d > 0
                      ? `${Math.round((row.converted30d / row.resolved30d) * 100)}% (${row.converted30d}/${row.resolved30d})`
                      : <span className="text-gray-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-gray-400 mt-3">
        週次のAI自動分析を有効にするには、設定キー <code className="bg-gray-100 px-1 rounded">advisor_weekly_enabled</code> を true にします (毎週月曜9時に自動生成され、送信Webhookの <code className="bg-gray-100 px-1 rounded">advisor_weekly_report</code> イベントで通知できます)。
      </p>
    </div>
  )
}
