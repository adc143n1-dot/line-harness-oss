'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

interface AiReplySettingProps {
  accountId: string
}

export default function AiReplySetting({ accountId }: AiReplySettingProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null) // null = 上位設定 (マスタースイッチ) に従う
  const [dailyLimit, setDailyLimit] = useState<number | null>(null)
  const [limitInput, setLimitInput] = useState('')
  const [stats, setStats] = useState<{ today: number; last7Days: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [enabledRes, limitRes, statsRes] = await Promise.all([
        api.accountSettings.getAiReplyEnabled(accountId),
        api.accountSettings.getAiReplyDailyLimit(accountId),
        api.accountSettings.getAiReplyStats(accountId),
      ])
      if (enabledRes.success) setEnabled(enabledRes.data)
      if (limitRes.success) {
        setDailyLimit(limitRes.data)
        setLimitInput(limitRes.data === null ? '' : String(limitRes.data))
      }
      if (statsRes.success) setStats(statsRes.data)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { load() }, [load])

  const toggle = async () => {
    // 3値トグル: 未設定(上位に従う) → 有効 → 無効 → 未設定 …ではなく、
    // ここでは単純に「有効/無効」の2値切替にする。上位に戻したい場合は稀なので、
    // 未設定状態からは「有効」を明示するところから始める。
    const next = enabled === true ? false : true
    setEnabled(next)
    setSaving(true)
    try {
      await api.accountSettings.updateAiReplyEnabled(accountId, next)
    } catch { /* ignore */ }
    finally { setSaving(false) }
  }

  const saveLimit = async () => {
    const trimmed = limitInput.trim()
    const next = trimmed === '' ? null : Number(trimmed)
    if (next !== null && (!Number.isInteger(next) || next < 0)) return
    setSaving(true)
    try {
      await api.accountSettings.updateAiReplyDailyLimit(accountId, next)
      setDailyLimit(next)
    } catch { /* ignore */ }
    finally { setSaving(false) }
  }

  if (loading) return <p className="text-xs text-gray-400 mt-3">読み込み中...</p>

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-gray-600">AI自動応答</h4>
        <button
          onClick={toggle}
          disabled={saving}
          className={`text-xs px-2 py-0.5 rounded-full disabled:opacity-50 ${
            enabled === false ? 'bg-gray-100 text-gray-500' : 'bg-purple-100 text-purple-700'
          }`}
          title="キーワード自動応答に一致せず、担当者未割当のときだけ発動します"
        >
          {enabled === false ? '無効' : '有効'}
        </button>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <label className="text-xs text-gray-500 whitespace-nowrap">1日の上限</label>
        <input
          type="number"
          min={0}
          value={limitInput}
          onChange={(e) => setLimitInput(e.target.value)}
          onBlur={saveLimit}
          placeholder="無制限"
          className="w-20 border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
        />
        <span className="text-xs text-gray-400">件{dailyLimit !== null ? ` (現在: ${dailyLimit})` : ''}</span>
      </div>

      {stats && (
        <p className="text-[11px] text-gray-400">
          送信実績: 本日 {stats.today}件 / 直近7日 {stats.last7Days}件
        </p>
      )}
    </div>
  )
}
