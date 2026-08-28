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

      <BridgeGuide />

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

// コピー可能なコードブロック
function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch { /* secure-context only */ }
  }
  return (
    <div className="rounded-lg border border-edge overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-alt border-b border-edge">
        <span className="text-xs font-medium text-ink-muted font-mono">{title}</span>
        <button onClick={copy} className="text-xs font-medium text-brand-600 hover:text-brand-700">
          {copied ? 'コピー済み' : 'コピー'}
        </button>
      </div>
      <pre className="p-3 text-xs leading-relaxed bg-app text-ink overflow-x-auto"><code>{code}</code></pre>
    </div>
  )
}

const BRIDGE_PY = `# bridge.py — 個人LINE ブリッジサーバー(最小構成 / Flask)
# ⚠️ 非公式クライアントの利用は LINE 利用規約に反し、アカウント凍結の
#    リスクを伴います。自己責任でご利用ください。
import os, threading, requests
from flask import Flask, request, jsonify

# 管理画面「個人LINE(ブリッジ)」の各アカウントに表示される3つの値を環境変数に:
HARNESS_WEBHOOK_URL = os.environ["HARNESS_WEBHOOK_URL"]  # = 受信WebフックURL
INBOUND_SECRET      = os.environ["INBOUND_SECRET"]        # = X-Bridge-Secret
BRIDGE_SECRET       = os.environ["BRIDGE_SECRET"]         # = Bearer bridge_secret

app = Flask(__name__)

# ── 非公式LINEクライアント(ここは各自で用意) ───────────────────────────
# 例として CHRLINE 等の非公式ライブラリを想定。QR+PINでログインし、得られた
# authToken を保存して再利用する(ログイン情報はこのサーバー内に閉じる)。
#   from CHRLINE import CHRLINE
#   line = CHRLINE()   # 初回QR/PINログイン、以降はtoken再利用
# 下記2つを、使うライブラリのAPIに合わせて実装するだけ。
def send_line_message(to_mid: str, text: str) -> None:
    # TODO: line.sendMessage(to_mid, text) 等に置き換える
    raise NotImplementedError

def receive_loop() -> None:
    # TODO: 非公式クライアントの受信ループ(擬似コード):
    #   while True:
    #     for op in line.fetchOps():
    #       if op.type == RECEIVE_MESSAGE and not op.message.from_is_self:
    #         forward_incoming(op.message.sender, line.getName(op.message.sender),
    #                          op.message.text)
    pass

# ── ハーネス → ブリッジ:送信(POST /send) ─────────────────────────────
@app.post("/send")
def send():
    if request.headers.get("Authorization") != f"Bearer {BRIDGE_SECRET}":
        return jsonify(ok=False), 401
    data = request.get_json(force=True)
    send_line_message(data["to"], data.get("content", ""))
    return jsonify(ok=True)

# ── 疎通確認(管理画面「疎通テスト」が GET /health を叩く) ─────────────
@app.get("/health")
def health():
    return jsonify(ok=True)

# ── ブリッジ → ハーネス:受信転送(受信ループから呼ぶ) ──────────────────
def forward_incoming(user_id: str, display_name: str, text: str,
                     picture_url: str | None = None) -> None:
    requests.post(
        HARNESS_WEBHOOK_URL,
        headers={"X-Bridge-Secret": INBOUND_SECRET, "Content-Type": "application/json"},
        json={"from": {"userId": user_id, "displayName": display_name,
                       "pictureUrl": picture_url},
              "message": {"type": "text", "text": text}},
        timeout=10,
    )

if __name__ == "__main__":
    # 受信ループは常時走らせる必要があるので別スレッドで起動
    threading.Thread(target=receive_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
`

const BRIDGE_DOCKERFILE = `FROM python:3.12-slim
WORKDIR /app
RUN pip install flask requests
# ↑ 非公式LINEクライアント(CHRLINE 等)も requirements に追加する
COPY bridge.py .
ENV PORT=8080
CMD ["python", "bridge.py"]
`

const BRIDGE_RUN = `# 1) ビルド & 起動(常時起動のVPS/サーバーで)
docker build -t line-bridge .
docker run -d --restart=always -p 8080:8080 \\
  -e HARNESS_WEBHOOK_URL="（管理画面の 受信WebフックURL）" \\
  -e INBOUND_SECRET="（管理画面の X-Bridge-Secret）" \\
  -e BRIDGE_SECRET="（管理画面の Bearer bridge_secret）" \\
  --name line-bridge line-bridge

# 2) HTTPS を付ける(ハーネスは https の bridge_base_url しか叩けない)
#    Caddy/Nginx 等のリバースプロキシで TLS 終端し、
#    https://あなたのドメイン を管理画面の bridge_base_url に設定する。`

// ブリッジサーバーの作り方ガイド(折りたたみ)
function BridgeGuide() {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-4 rounded-lg border border-edge bg-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-semibold text-ink">🛠 ブリッジサーバーの作り方(最小構成)</span>
        <span className="text-xs text-ink-faint">{open ? '閉じる ▲' : '開く ▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 text-sm text-ink-muted border-t border-edge pt-4">
          <div>
            <p className="font-medium text-ink mb-1">全体像</p>
            <pre className="p-3 text-xs leading-relaxed bg-app text-ink rounded-lg border border-edge overflow-x-auto"><code>{`[あなたの個人LINE]
   ⇅ 非公式クライアント(QR+PINでログイン)
[常時起動のブリッジサーバー(あなたが用意)]
   ⇅ このハーネスと HTTP で接続
[このハーネス(管理画面のチャット)]`}</code></pre>
            <p className="mt-2">
              個人LINEには公式APIが無いため、非公式クライアントを載せた小さな中継サーバー(ブリッジ)を
              常時起動し、ハーネスとは下記2つのHTTPだけでやり取りします。
              <span className="font-medium text-ink"> 受信</span>: ブリッジ→ハーネスの受信WebフックへPOST /
              <span className="font-medium text-ink"> 送信</span>: ハーネス→ブリッジの <code>/send</code> へPOST。
            </p>
          </div>

          <div>
            <p className="font-medium text-ink mb-1">用意するもの</p>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>常時起動できるサーバー(VPS / Docker など)。無料枠のサーバーレスは不可(受信を延々と待ち受けるため)。</li>
              <li>HTTPS(ハーネスは <code>https</code> の <code>bridge_base_url</code> しか呼べません)。</li>
              <li>非公式LINEクライアント・ライブラリ(例: <span className="font-mono">CHRLINE</span> 等)。これがToS上のリスク源です。</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-ink mb-1">管理画面の値 → 環境変数の対応</p>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>「受信WebフックURL」 → <code>HARNESS_WEBHOOK_URL</code></li>
              <li>「X-Bridge-Secret(受信認証)」 → <code>INBOUND_SECRET</code></li>
              <li>「Bearer bridge_secret(送信認証)」 → <code>BRIDGE_SECRET</code></li>
              <li>公開したブリッジのURL(例 <span className="font-mono">https://…</span>) → 各アカウントの <span className="font-medium text-ink">bridge_base_url</span> に設定</li>
            </ul>
          </div>

          <CodeBlock title="bridge.py" code={BRIDGE_PY} />
          <CodeBlock title="Dockerfile" code={BRIDGE_DOCKERFILE} />
          <CodeBlock title="起動コマンド" code={BRIDGE_RUN} />

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs">
            <p className="font-medium text-ink">⚠️ 実装のポイントと注意</p>
            <ul className="mt-1 list-disc pl-5 space-y-0.5">
              <li>実装が必要なのは <code>send_line_message</code> と <code>receive_loop</code> の2箇所だけ。使う非公式ライブラリのAPIに合わせて埋めます。</li>
              <li>Bot自身(自分)の送信メッセージは受信転送しない(ループ防止)。</li>
              <li>ログイン情報(QR/PIN・authToken)はこのサーバー内に閉じ、ハーネスには渡しません。</li>
              <li>非公式クライアントの利用はLINE規約違反・凍結リスクを伴います。守りたいアカウントでの利用は避け、是非はご自身で判断してください。</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
