'use client'

import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'
import type { TelegramAccountItem } from '@/lib/api'
import Header from '@/components/layout/header'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { LoadingState } from '@/components/ui/spinner'
import EmptyState from '@/components/ui/empty-state'
import { Icon } from '@/components/ui/icons'

export default function TelegramAccountsPage() {
  const { confirm, alert } = useConfirm()
  const [items, setItems] = useState<TelegramAccountItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const [form, setForm] = useState({ name: '', botUsername: '', botToken: '' })

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await api.telegramAccounts.list()
      if (res.success) setItems(res.data)
      else setError(res.error)
    } catch { setError('読み込みに失敗しました') }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const create = async () => {
    if (!form.name.trim() || !form.botUsername.trim() || !form.botToken.trim()) {
      await alert({ title: '入力が不足しています', message: '表示名・Botユーザー名・Botトークンをすべて入力してください。' })
      return
    }
    setSaving(true)
    try {
      const res = await api.telegramAccounts.create({
        name: form.name.trim(),
        botUsername: form.botUsername.trim().replace(/^@/, ''),
        botToken: form.botToken.trim(),
      })
      if (res.success) {
        setForm({ name: '', botUsername: '', botToken: '' })
        setShowForm(false)
        await load()
        if (!res.data.webhookRegistered) {
          await alert({
            title: 'Bot は登録されましたが Webhook 設定に失敗しました',
            message: '一覧の「Webhook再設定」ボタンで再試行できます。Botトークンが正しいかご確認ください。',
          })
        }
      } else {
        await alert({ title: '作成に失敗しました', message: res.error })
      }
    } catch {
      await alert({ title: '作成に失敗しました', message: '通信エラーが発生しました。' })
    }
    setSaving(false)
  }

  const toggleActive = async (a: TelegramAccountItem) => {
    await api.telegramAccounts.update(a.id, { isActive: !a.isActive })
    await load()
  }

  const reRegister = async (a: TelegramAccountItem) => {
    const res = await api.telegramAccounts.registerWebhook(a.id)
    await alert(
      res.success && res.data.webhookRegistered
        ? { title: 'Webhook を再設定しました' }
        : { title: 'Webhook 再設定に失敗しました', message: 'Botトークンとネットワークをご確認ください。' },
    )
  }

  const remove = async (a: TelegramAccountItem) => {
    if (!(await confirm({ title: `${a.name} を削除しますか?`, message: 'このBot経由の連絡先・会話は残りますが、送受信はできなくなります。', tone: 'danger', confirmLabel: '削除する' }))) return
    await api.telegramAccounts.remove(a.id)
    await load()
  }

  const copyWebhook = async (a: TelegramAccountItem) => {
    if (!a.webhookUrl) return
    try {
      await navigator.clipboard.writeText(a.webhookUrl)
      setCopiedId(a.id)
      setTimeout(() => setCopiedId(null), 1200)
    } catch { /* secure-context only */ }
  }

  return (
    <div>
      <Header
        title="Telegramアカウント"
        description="Telegram Bot を登録すると、顧客との会話を個別チャット・チャットボードでLINEと同じように管理できます。"
        action={
          <button
            onClick={() => setShowForm((v) => !v)}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg bg-brand-600 hover:bg-brand-700"
          >
            {showForm ? '閉じる' : '+ Botを追加'}
          </button>
        }
      />

      <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 p-4 text-sm text-ink-muted">
        <p className="font-medium text-ink">はじめかた</p>
        <ol className="mt-1 list-decimal pl-5 space-y-0.5">
          <li>Telegramで <span className="font-medium text-ink">@BotFather</span> からBotを作成し、Botトークンとユーザー名を取得</li>
          <li>ここで「+ Botを追加」して登録(登録時に自動でWebhookを設定します)</li>
          <li>ユーザーがそのBotにメッセージを送ると、個別チャットに会話が現れます</li>
        </ol>
      </div>

      {error && <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {showForm && (
        <div className="mb-4 bg-surface rounded-lg border border-edge shadow-sm p-5 space-y-3 max-w-xl">
          <label className="block">
            <span className="block text-sm font-medium text-ink mb-1">表示名</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例: サポート窓口"
              className="w-full px-3 py-2 text-sm border border-edge rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-ink mb-1">Botユーザー名</span>
            <input value={form.botUsername} onChange={(e) => setForm({ ...form, botUsername: e.target.value })}
              placeholder="例: my_support_bot ( @ は不要 )"
              className="w-full px-3 py-2 text-sm border border-edge rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-ink mb-1">Botトークン</span>
            <input type="password" value={form.botToken} onChange={(e) => setForm({ ...form, botToken: e.target.value })}
              placeholder="123456:ABC-DEF..."
              className="w-full px-3 py-2 text-sm border border-edge rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
            <span className="block mt-1 text-xs text-ink-faint">BotFatherが発行したトークン。保存後は末尾4桁のみ表示されます。</span>
          </label>
          <button onClick={create} disabled={saving}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50">
            {saving ? '登録中…' : '登録してWebhookを設定'}
          </button>
        </div>
      )}

      {loading ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Icon name="chat" className="w-6 h-6" />}
          title="Telegram Bot がまだありません"
          description="BotFatherでBotを作成し、「+ Botを追加」から登録してください。"
        />
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <div key={a.id} className="bg-surface rounded-lg border border-edge shadow-sm p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{a.name}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${a.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {a.isActive ? '有効' : '無効'}
                    </span>
                  </div>
                  <p className="text-xs text-ink-faint mt-0.5 font-mono">@{a.botUsername} · token ••••{a.botTokenLast4 ?? '----'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => toggleActive(a)} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-muted hover:bg-surface-alt">
                    {a.isActive ? '無効化' : '有効化'}
                  </button>
                  <button onClick={() => reRegister(a)} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-muted hover:bg-surface-alt">
                    Webhook再設定
                  </button>
                  <button onClick={() => remove(a)} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 text-red-600 hover:bg-red-50">
                    削除
                  </button>
                </div>
              </div>
              {a.webhookUrl && (
                <div className="mt-3 flex items-stretch gap-2">
                  <input readOnly value={a.webhookUrl} onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 border border-edge rounded-lg px-3 py-2 text-xs font-mono bg-app text-ink-muted truncate" />
                  <button onClick={() => copyWebhook(a)}
                    className="px-3 rounded-lg text-xs font-medium border border-edge text-ink-muted hover:bg-surface-alt shrink-0">
                    {copiedId === a.id ? 'コピー済み' : 'URLをコピー'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
