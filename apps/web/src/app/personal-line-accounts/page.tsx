'use client'

import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'
import type { PersonalLineAccountItem } from '@/lib/api'
import Header from '@/components/layout/header'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { LoadingState } from '@/components/ui/spinner'
import EmptyState from '@/components/ui/empty-state'
import { Icon } from '@/components/ui/icons'

export default function PersonalLineAccountsPage() {
  const { confirm, alert } = useConfirm()
  const [items, setItems] = useState<PersonalLineAccountItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const [form, setForm] = useState({ name: '', bridgeBaseUrl: '' })

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await api.personalLineAccounts.list()
      if (res.success) setItems(res.data)
      else setError(res.error)
    } catch { setError('読み込みに失敗しました') }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const create = async () => {
    if (!form.name.trim()) {
      await alert({ title: '入力が不足しています', message: '表示名を入力してください。' })
      return
    }
    setSaving(true)
    try {
      const res = await api.personalLineAccounts.create({
        name: form.name.trim(),
        bridgeBaseUrl: form.bridgeBaseUrl.trim() || null,
      })
      if (res.success) {
        setForm({ name: '', bridgeBaseUrl: '' })
        setShowForm(false)
        await load()
      } else {
        await alert({ title: '作成に失敗しました', message: res.error })
      }
    } catch {
      await alert({ title: '作成に失敗しました', message: '通信エラーが発生しました。' })
    }
    setSaving(false)
  }

  const toggleActive = async (a: PersonalLineAccountItem) => {
    await api.personalLineAccounts.update(a.id, { isActive: !a.isActive })
    await load()
  }

  const testBridge = async (a: PersonalLineAccountItem) => {
    const res = await api.personalLineAccounts.testBridge(a.id)
    await alert(
      res.success && res.data.reachable
        ? { title: 'ブリッジに接続できました', message: `HTTP ${res.data.status}` }
        : { title: 'ブリッジに接続できませんでした', message: 'bridge_base_url とブリッジサーバーの稼働状況をご確認ください。' },
    )
  }

  const remove = async (a: PersonalLineAccountItem) => {
    if (!(await confirm({ title: `${a.name} を削除しますか?`, message: 'このアカウント経由の連絡先・会話は残りますが、送受信はできなくなります。', tone: 'danger', confirmLabel: '削除する' }))) return
    await api.personalLineAccounts.remove(a.id)
    await load()
  }

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      setTimeout(() => setCopied(null), 1200)
    } catch { /* secure-context only */ }
  }

  return (
    <div>
      <Header
        title="個人LINE(ブリッジ)"
        description="個人LINEには公式APIが無いため、非公式クライアントを載せた外部ブリッジサーバー経由で送受信します。ここでは接続情報だけを管理します。"
        action={
          <button
            onClick={() => setShowForm((v) => !v)}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg bg-brand-600 hover:bg-brand-700"
          >
            {showForm ? '閉じる' : '+ アカウントを追加'}
          </button>
        }
      />

      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-ink-muted">
        <p className="font-medium text-ink">⚠️ ご注意</p>
        <p className="mt-1">
          個人LINEアカウントを非公式クライアントで自動化する行為は <span className="font-medium text-ink">LINEの利用規約に反し、アカウント凍結のリスク</span> があります。
          利用の是非はご自身の判断でお願いします。ログイン情報はこの管理画面では扱わず、ブリッジサーバー側でご自身が認証します。
        </p>
        <p className="mt-2 font-medium text-ink">使い方</p>
        <ol className="mt-1 list-decimal pl-5 space-y-0.5">
          <li>ここで「+ アカウントを追加」して、ブリッジ用の接続情報(WebフックURL・シークレット)を発行</li>
          <li>常時起動のブリッジサーバー(非公式クライアント)を用意し、下記の値を設定</li>
          <li>ブリッジ側で個人LINEにログイン(QR+PIN等)すると、受信が個別チャットに現れます</li>
        </ol>
      </div>

      {error && <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {showForm && (
        <div className="mb-4 bg-surface rounded-lg border border-edge shadow-sm p-5 space-y-3 max-w-xl">
          <label className="block">
            <span className="block text-sm font-medium text-ink mb-1">表示名</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例: 個人LINE窓口"
              className="w-full px-3 py-2 text-sm border border-edge rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-ink mb-1">ブリッジURL (bridge_base_url)</span>
            <input value={form.bridgeBaseUrl} onChange={(e) => setForm({ ...form, bridgeBaseUrl: e.target.value })}
              placeholder="例: https://my-bridge.example.com ( 後で設定でも可 )"
              className="w-full px-3 py-2 text-sm border border-edge rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
            <span className="block mt-1 text-xs text-ink-faint">送信時にこのURLの /send へ POST します。未入力なら受信のみ(送信はURL設定後)。</span>
          </label>
          <button onClick={create} disabled={saving}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50">
            {saving ? '作成中…' : '作成して接続情報を発行'}
          </button>
        </div>
      )}

      {loading ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Icon name="chat" className="w-6 h-6" />}
          title="個人LINE(ブリッジ)アカウントがまだありません"
          description="「+ アカウントを追加」から接続情報を発行してください。"
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
                  <p className="text-xs text-ink-faint mt-0.5 font-mono">{a.bridgeBaseUrl || 'bridge_base_url 未設定'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => testBridge(a)} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-muted hover:bg-surface-alt">
                    疎通テスト
                  </button>
                  <button onClick={() => toggleActive(a)} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-muted hover:bg-surface-alt">
                    {a.isActive ? '無効化' : '有効化'}
                  </button>
                  <button onClick={() => remove(a)} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 text-red-600 hover:bg-red-50">
                    削除
                  </button>
                </div>
              </div>

              {/* ブリッジ設定用の接続情報 */}
              <div className="mt-3 space-y-2">
                <SecretRow label="受信WebフックURL" value={a.webhookUrl ?? ''} k={`${a.id}-url`} copied={copied} onCopy={copy} />
                <SecretRow label="X-Bridge-Secret (受信認証)" value={a.inboundSecret} k={`${a.id}-in`} copied={copied} onCopy={copy} />
                <SecretRow label="Bearer bridge_secret (送信認証)" value={a.bridgeSecret} k={`${a.id}-out`} copied={copied} onCopy={copy} />
              </div>
              <p className="mt-2 text-xs text-ink-faint">
                受信: ブリッジ → 上記URLへ <code>X-Bridge-Secret</code> 付きで POST /
                送信: ハーネス → <code>{a.bridgeBaseUrl || 'bridge_base_url'}/send</code> へ <code>Authorization: Bearer</code> 付きで POST。
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SecretRow({
  label, value, k, copied, onCopy,
}: {
  label: string
  value: string
  k: string
  copied: string | null
  onCopy: (key: string, value: string) => void
}) {
  return (
    <div>
      <span className="block text-xs text-ink-muted mb-0.5">{label}</span>
      <div className="flex items-stretch gap-2">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()}
          className="flex-1 border border-edge rounded-lg px-3 py-2 text-xs font-mono bg-app text-ink-muted truncate" />
        <button onClick={() => onCopy(k, value)}
          className="px-3 rounded-lg text-xs font-medium border border-edge text-ink-muted hover:bg-surface-alt shrink-0">
          {copied === k ? 'コピー済み' : 'コピー'}
        </button>
      </div>
    </div>
  )
}
