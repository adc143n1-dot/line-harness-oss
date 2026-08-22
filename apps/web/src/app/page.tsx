'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import CcPromptButton from '@/components/cc-prompt-button'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import { Icon } from '@/components/ui/icons'
import type { IconName } from '@/components/ui/icons'

const ccPrompts = [
  {
    title: 'ダッシュボードのKPI分析',
    prompt: `LINE CRM ダッシュボードのデータを分析してください。
1. 友だち数の推移を確認
2. アクティブシナリオの効果を評価
3. 配信の開封率・クリック率を分析
改善提案を含めてレポートしてください。`,
  },
  {
    title: '新しいシナリオを提案',
    prompt: `現在の友だちデータとタグ情報を元に、効果的なシナリオ配信を提案してください。
1. ターゲットセグメントの特定
2. メッセージ内容の提案
3. 配信タイミングの最適化
具体的なステップ配信の構成を含めてください。`,
  },
]

interface DashboardStats {
  friendCount: number | null
  activeScenarioCount: number | null
  broadcastCount: number | null
  templateCount: number | null
  automationCount: number | null
  scoringRuleCount: number | null
}

interface StatCardProps {
  title: string
  value: number | null
  loading: boolean
  icon: IconName
  href: string
}

function StatCard({ title, value, loading, icon, href }: StatCardProps) {
  return (
    <Link href={href} className="block bg-surface rounded-lg shadow-sm border border-edge p-6 hover:shadow-md hover:border-brand-300 transition-all group">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-ink-muted mb-2">{title}</p>
          {loading ? (
            <div className="h-8 w-20 bg-surface-alt rounded animate-pulse" />
          ) : (
            <p className="text-3xl font-bold text-ink">
              {value !== null ? value.toLocaleString('ja-JP') : '-'}
            </p>
          )}
        </div>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-brand-100 text-brand-700 shrink-0">
          <Icon name={icon} />
        </div>
      </div>
      <p className="text-xs text-ink-faint mt-3 group-hover:text-brand-600 transition-colors">
        詳細を見る →
      </p>
    </Link>
  )
}

// 友だち追加リンクの即時取得カード。/auth/line は UUID 付与・アカウント解決・
// PC では QR ランディング表示までやる正規の流入口なので、共有リンクは常に
// これを配る (公式の lin.ee 直リンクだと計測も UUID 紐づけも失われる)。
function FriendAddLinkCard() {
  const { selectedAccount } = useAccount()
  const [copied, setCopied] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const base = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')
  const link = selectedAccount
    ? `${base}/auth/line?account=${encodeURIComponent(selectedAccount.channelId)}`
    : `${base}/auth/line`

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // clipboard requires a secure context; the input below allows manual copy
    }
  }

  return (
    <div className="mb-6 bg-surface rounded-lg shadow-sm border border-edge p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm font-semibold text-ink">友だち追加リンク</p>
          <p className="text-xs text-ink-faint mt-0.5">
            {selectedAccount
              ? `${selectedAccount.displayName || selectedAccount.name} への追加リンク (UUID計測つき)`
              : 'デフォルトアカウントへの追加リンク (UUID計測つき)'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowQr((v) => !v)}
          className="text-xs px-3 py-1.5 rounded-lg border border-edge hover:bg-surface-alt font-medium text-ink-muted"
        >
          {showQr ? 'QRを隠す' : 'QR表示'}
        </button>
      </div>
      <div className="flex items-stretch gap-2">
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 border border-edge rounded-lg px-3 py-2 text-xs font-mono bg-app text-ink-muted truncate"
        />
        {/* 友だち追加につながるLINE操作なのでLINE緑を使う */}
        <button
          type="button"
          onClick={onCopy}
          className={`px-4 rounded-lg text-xs font-medium text-white shrink-0 transition-colors ${copied ? 'bg-success' : 'bg-line hover:bg-line-dark'}`}
        >
          {copied ? 'コピーしました ✓' : 'コピー'}
        </button>
      </div>
      {showQr && (
        <div className="mt-3 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- worker QR proxy, not a static asset */}
          <img
            src={`${base}/api/qr?data=${encodeURIComponent(link)}&size=240x240`}
            alt="友だち追加QRコード"
            width={240}
            height={240}
            className="border border-edge rounded-lg"
          />
        </div>
      )}
    </div>
  )
}

const QUICK_ACTIONS: { href: string; icon: IconName; title: string; description: string }[] = [
  { href: '/friends', icon: 'users', title: '友だち管理', description: '友だちの一覧・タグ管理' },
  { href: '/scenarios', icon: 'clipboard-list', title: 'シナリオ配信', description: '自動配信シナリオの作成・編集' },
  { href: '/broadcasts', icon: 'megaphone', title: '一斉配信', description: 'メッセージの一斉送信・予約' },
  { href: '/chats', icon: 'chat', title: 'チャット', description: 'オペレーターチャット管理' },
  { href: '/health', icon: 'shield', title: 'BAN検知', description: 'アカウント健康度ダッシュボード' },
]

export default function DashboardPage() {
  const { selectedAccountId, selectedAccount } = useAccount()
  const [stats, setStats] = useState<DashboardStats>({
    friendCount: null,
    activeScenarioCount: null,
    broadcastCount: null,
    templateCount: null,
    automationCount: null,
    scoringRuleCount: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const [friendCountRes, scenariosRes, broadcastsRes, templatesRes, automationsRes, scoringRes] = await Promise.allSettled([
          api.friends.count({ accountId: selectedAccountId ?? undefined }),
          api.scenarios.list(),
          api.broadcasts.list(),
          api.templates.list(),
          api.automations.list(),
          api.mileage.rules(),
        ])

        setStats({
          friendCount:
            friendCountRes.status === 'fulfilled' && friendCountRes.value.success
              ? friendCountRes.value.data.count
              : null,
          activeScenarioCount:
            scenariosRes.status === 'fulfilled' && scenariosRes.value.success
              ? scenariosRes.value.data.filter((s) => s.isActive).length
              : null,
          broadcastCount:
            broadcastsRes.status === 'fulfilled' && broadcastsRes.value.success
              ? broadcastsRes.value.data.length
              : null,
          templateCount:
            templatesRes.status === 'fulfilled' && templatesRes.value.success
              ? templatesRes.value.data.length
              : null,
          automationCount:
            automationsRes.status === 'fulfilled' && automationsRes.value.success
              ? automationsRes.value.data.filter((a) => a.isActive).length
              : null,
          scoringRuleCount:
            scoringRes.status === 'fulfilled' && scoringRes.value.success
              ? scoringRes.value.data.length
              : null,
        })
      } catch {
        setError('データの読み込みに失敗しました')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [selectedAccountId])

  return (
    <div>
      <Header
        title="ダッシュボード"
        description={
          selectedAccount
            ? `${selectedAccount.displayName || selectedAccount.name} の管理画面`
            : 'LINE公式アカウント CRM 管理画面'
        }
      />

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <FriendAddLinkCard />

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
        <StatCard title="友だち数" value={stats.friendCount} loading={loading} href="/friends" icon="users" />
        <StatCard title="アクティブシナリオ数" value={stats.activeScenarioCount} loading={loading} href="/scenarios" icon="clipboard-list" />
        <StatCard title="配信数 (合計)" value={stats.broadcastCount} loading={loading} href="/broadcasts" icon="megaphone" />
        <StatCard title="テンプレート数" value={stats.templateCount} loading={loading} href="/templates" icon="template" />
        <StatCard title="アクティブルール数" value={stats.automationCount} loading={loading} href="/automations" icon="bolt" />
        <StatCard title="マイル付与ルール数" value={stats.scoringRuleCount} loading={loading} href="/scoring" icon="star" />
      </div>

      {/* Quick links */}
      <div className="bg-surface rounded-lg shadow-sm border border-edge p-6">
        <h2 className="text-sm font-semibold text-ink mb-4">クイックアクション</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="flex items-center gap-3 p-3 rounded-lg border border-edge hover:border-brand-300 hover:bg-brand-50 transition-colors group"
            >
              <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-brand-100 text-brand-700 shrink-0">
                <Icon name={action.icon} className="w-4 h-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-ink group-hover:text-brand-700 transition-colors">{action.title}</p>
                <p className="text-xs text-ink-faint">{action.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}
