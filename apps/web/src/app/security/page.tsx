'use client'

import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import { Icon } from '@/components/ui/icons'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { LoadingState } from '@/components/ui/spinner'

export default function SecurityPage() {
  const { confirm } = useConfirm()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [enabled, setEnabled] = useState(false)
  const [entriesText, setEntriesText] = useState('')
  const [currentIp, setCurrentIp] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.security.getIpAllowlist()
      if (res.success) {
        setEnabled(res.data.config.enabled)
        setEntriesText(res.data.config.entries.join('\n'))
        setCurrentIp(res.data.currentIp)
      } else {
        setError(res.error)
      }
    } catch {
      setError('読み込みに失敗しました')
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const parsedEntries = () =>
    entriesText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

  const addCurrentIp = () => {
    if (!currentIp) return
    const list = parsedEntries()
    if (list.includes(currentIp)) return
    setEntriesText([...list, currentIp].join('\n'))
  }

  const currentIpCovered = () => {
    if (!currentIp) return false
    // 完全一致のみ簡易チェック (CIDR内判定はサーバーが厳密に行う)。
    return parsedEntries().includes(currentIp)
  }

  const save = async () => {
    setError('')
    setNotice('')
    const entries = parsedEntries()

    if (enabled) {
      const ok = await confirm({
        title: 'アクセス制限を有効にします',
        message:
          '許可リストに含まれないIPからは、この管理画面にログインできなくなります。\n' +
          '現在のIPが含まれていることを確認してください。よろしいですか?',
        confirmLabel: '有効にして保存',
      })
      if (!ok) return
    }

    setSaving(true)
    try {
      const res = await api.security.setIpAllowlist({ enabled, entries })
      if (res.success) {
        setEnabled(res.data.config.enabled)
        setEntriesText(res.data.config.entries.join('\n'))
        setNotice(enabled ? 'アクセス制限を有効にして保存しました' : '保存しました (現在は無効)')
      } else {
        setError(res.error)
      }
    } catch {
      setError('保存に失敗しました')
    }
    setSaving(false)
  }

  return (
    <div>
      <Header
        title="アクセス制限 (IP許可リスト)"
        description="この管理画面にログイン・アクセスできる送信元IPを、社内固定IPなどに限定します。オーナーのみ設定できます。"
      />

      {/* 説明・注意 */}
      <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 p-4 text-sm text-ink-muted">
        <p className="font-medium text-ink flex items-center gap-1.5">
          <Icon name="lock" className="w-4 h-4 text-brand-600" />
          これは「このCRM管理画面へのアクセス」を制限する機能です
        </p>
        <ul className="mt-2 list-disc pl-5 space-y-1">
          <li>許可リストは <span className="font-medium text-ink">ログインと管理API</span> に適用されます。友だち向けのフォーム・LINE連携ページには影響しません。</li>
          <li>IP または CIDR で指定します(例: <code className="px-1 bg-white rounded border border-edge">203.0.113.10</code> / <code className="px-1 bg-white rounded border border-edge">203.0.113.0/24</code>)。IPv6 も可。</li>
          <li>有効化時は、いまアクセス中のIPが含まれていないと保存できません(締め出し防止)。</li>
        </ul>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm whitespace-pre-wrap">{error}</div>
      )}
      {notice && (
        <div className="mb-4 p-4 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-700 text-sm">{notice}</div>
      )}

      {loading ? (
        <LoadingState />
      ) : (
        <div className="bg-surface rounded-lg border border-edge shadow-sm p-6 space-y-6 max-w-2xl">
          {/* 現在のIP */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium text-ink">現在アクセス中のIP</p>
              <p className="text-lg font-mono text-brand-700 mt-0.5">{currentIp ?? '取得できませんでした'}</p>
            </div>
            <button
              type="button"
              onClick={addCurrentIp}
              disabled={!currentIp || currentIpCovered()}
              className="px-3 py-2 min-h-[44px] text-sm font-medium rounded-lg border border-edge text-ink-muted hover:bg-surface-alt disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {currentIpCovered() ? '追加済み' : '現在のIPを追加'}
            </button>
          </div>

          {/* 有効トグル */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-1 w-5 h-5 accent-brand-600"
            />
            <span>
              <span className="text-sm font-medium text-ink">アクセス制限を有効にする</span>
              <span className="block text-xs text-ink-faint mt-0.5">
                オフのあいだは制限されません(どのIPからでもアクセス可能)。
              </span>
            </span>
          </label>

          {/* 許可リスト */}
          <div>
            <label className="block text-sm font-medium text-ink mb-1">
              許可するIP / CIDR(1行に1つ)
            </label>
            <textarea
              value={entriesText}
              onChange={(e) => setEntriesText(e.target.value)}
              rows={6}
              spellCheck={false}
              placeholder={'203.0.113.10\n203.0.113.0/24\n2001:db8::/32'}
              className="w-full px-3 py-2 text-sm font-mono text-ink bg-surface border border-edge rounded-lg placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
            {enabled && currentIp && !currentIpCovered() && (
              <p className="mt-1 text-xs text-warn">
                ※ 現在のIP ({currentIp}) が一覧に無いようです。CIDRで含めている場合を除き、このままだと保存が拒否されます。
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              onClick={load}
              disabled={saving}
              className="px-4 py-2 min-h-[44px] text-sm font-medium rounded-lg border border-edge text-ink-muted hover:bg-surface-alt disabled:opacity-50"
            >
              変更を破棄
            </button>
          </div>

          {/* 復旧手順 */}
          <div className="pt-4 border-t border-edge text-xs text-ink-faint">
            <p className="font-medium text-ink-muted">万一ロックアウトされた場合の復旧</p>
            <p className="mt-1">
              サーバー管理者が、D1データベースで次を実行すると制限を解除できます:
            </p>
            <pre className="mt-1 p-2 bg-surface-alt rounded border border-edge overflow-x-auto">
{`wrangler d1 execute <DB> --remote --command \\
  "DELETE FROM account_settings WHERE line_account_id='__global__' AND key='admin_ip_allowlist'"`}
            </pre>
            <p className="mt-1">または環境変数 <code className="px-1 bg-surface-alt rounded">ADMIN_IP_ALLOWLIST_BYPASS=true</code> を設定して再デプロイします。</p>
          </div>
        </div>
      )}
    </div>
  )
}
