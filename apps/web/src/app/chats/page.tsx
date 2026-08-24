'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { parseStickerMessageContent, stickerFallback } from '@line-crm/shared'
import { api, fetchApi, ApiError } from '@/lib/api'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import { Icon } from '@/components/ui/icons'
import Button from '@/components/ui/button'
import EmptyState from '@/components/ui/empty-state'
import { LoadingState } from '@/components/ui/spinner'
import { useConfirm } from '@/components/ui/confirm-dialog'
import CcPromptButton from '@/components/cc-prompt-button'
import FlexPreviewComponent from '@/components/flex-preview'
import FriendInfoSidebar from '@/components/chats/friend-info-sidebar'
import ImageUploader, { type ImageUploaderValue } from '@/components/shared/image-uploader'

interface ChatNote {
  id: string
  content: string
  createdAt: string
  staffId: string | null
  staffName: string | null
}

interface Chat {
  id: string
  friendId: string
  friendName: string
  friendPictureUrl: string | null
  operatorId: string | null
  status: 'unread' | 'in_progress' | 'waiting_reply' | 'resolved'
  /** 進行状態とは独立した成果。VIP は顧客属性なのでタグ側で扱う */
  outcome: 'converted' | 'lost' | null
  /** 友だち追加 URL の `?lp=xxx` から採取した流入元 */
  source: string | null
  /** 連絡先のチャネル (line / telegram)。081 マルチチャネル */
  channel: 'line' | 'telegram'
  /** 紐付け済みの Telegram ユーザー ID (未連携なら null) */
  telegramUserId: string | null
  /** 紐付け済みの Discord ユーザー ID (未連携なら null) */
  discordUserId: string | null
  /** 楽観ロック用。更新のたびに +1 される */
  version: number
  notes: string | null
  lastMessageAt: string | null
  lastMessageContent: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  lastMessageType: string | null
  createdAt: string
  updatedAt: string
}

interface ChatMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

interface SearchHit {
  id: string
  friendId: string
  friendName: string
  friendPictureUrl: string | null
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

interface ChatDetail extends Chat {
  friendName: string
  friendPictureUrl: string | null
  tgVerifiedAt?: string | null
  discordVerifiedAt?: string | null
  /** 再連絡予約 (スヌーズ) の期日。設定中はこの時刻に未対応として再浮上する */
  snoozeUntil?: string | null
  messages?: ChatMessage[]
}

type StatusFilter = 'all' | 'unread' | 'in_progress' | 'resolved'

const statusConfig: Record<Chat['status'], { label: string; className: string }> = {
  unread: { label: '未読', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  waiting_reply: { label: '返信待ち', className: 'bg-blue-100 text-blue-700' },
  resolved: { label: '解決済', className: 'bg-emerald-50 text-emerald-700' },
}

// 進行状態と成果は別々に持つ。1 つのセレクタに混ぜると「成約した対応中」や
// 「VIP かつ 返信待ち」が表現できなくなる。VIP は人単位の属性なのでタグで付ける。
const progressOptions: { value: Chat['status']; label: string }[] = [
  { value: 'unread', label: '新規' },
  { value: 'in_progress', label: '対応中' },
  { value: 'waiting_reply', label: '返信待ち' },
  { value: 'resolved', label: '完了' },
]

const outcomeOptions: { value: '' | NonNullable<Chat['outcome']>; label: string }[] = [
  { value: '', label: '― 成果未設定' },
  { value: 'converted', label: '成約' },
  { value: 'lost', label: '離脱' },
]

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全て' },
  { key: 'unread', label: '未読' },
  { key: 'in_progress', label: '対応中' },
  { key: 'resolved', label: '解決済' },
]

const SHOW_LOADING_PREF_KEY = 'lh_chat_show_loading_indicator'
// 一覧の1ページ件数。worker 側 /api/chats のデフォルト LIMIT と揃える。
const CHAT_PAGE_SIZE = 300
const LOADING_SECONDS_PREF_KEY = 'lh_chat_loading_seconds'
const LOADING_REFRESH_INTERVAL_MS = 4000

function StickerMessageImage({ content }: { content: string }) {
  const [failed, setFailed] = useState(false)
  const sticker = parseStickerMessageContent(content)
  const fallback = stickerFallback(content)

  if (!sticker || failed) return <span>{fallback}</span>

  return (
    <img
      src={sticker.stickerUrl}
      alt={fallback}
      className="max-h-[140px] max-w-[140px] object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function formatDatetime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sameYmd(aIso: string, bIso: string): boolean {
  const a = new Date(aIso)
  const b = new Date(bIso)
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatYmdSlash(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// 一覧の相対時刻表示 (チャットアプリ風)。当日=時刻 / 昨日 / 今年=M/D / それ以前=YYYY/M/D。
function formatRelativeTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000)
  if (diffMin < 1) return 'たった今'
  if (diffMin < 60) return `${diffMin}分前`
  if (sameYmd(iso, now.toISOString())) {
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameYmd(iso, yesterday.toISOString())) return '昨日'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return formatYmdSlash(iso)
}

// チャネル表示バッジ。LINE=緑ドット / Telegram=スカイ。一覧行・スレッドヘッダーで共通利用。
function ChannelBadge({ channel, className = '' }: { channel: 'line' | 'telegram'; className?: string }) {
  if (channel === 'telegram') {
    return (
      <span
        className={`inline-flex items-center gap-1 flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-700 font-medium ${className}`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-sky-500" aria-hidden="true" /> Telegram
      </span>
    )
  }
  return (
    <span
      className={`inline-flex items-center gap-1 flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-medium ${className}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-line" aria-hidden="true" /> LINE
    </span>
  )
}

const ccPrompts = [
  {
    title: 'チャット対応テンプレート',
    prompt: `チャット対応で使えるテンプレートメッセージを作成してください。
1. よくある質問への回答テンプレート（挨拶、FAQ、サポート）
2. クレーム対応用の丁寧な返信テンプレート
3. フォローアップメッセージのテンプレート
手順を示してください。`,
  },
  {
    title: '未対応チャット確認',
    prompt: `未対応のチャットを確認し、対応優先度を整理してください。
1. 未読・対応中のチャット数を集計
2. 最終メッセージからの経過時間で優先度を判定
3. 長時間未対応のチャットへの対応アクションを提案
結果をレポートしてください。`,
  },
]

interface FriendItem {
  id: string
  displayName: string
  pictureUrl: string | null
  isFollowing: boolean
}

interface MessageLog {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

function DirectMessagePanel({ friendId, friend, onBack, onSent }: {
  friendId: string
  friend: FriendItem | null
  onBack: () => void
  onSent: () => void
}) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<MessageLog[]>([])
  const [loadingMessages, setLoadingMessages] = useState(true)
  const isComposingRef = useRef(false)
  const sendLockRef = useRef(false)

  useEffect(() => {
    const loadMessages = async () => {
      setLoadingMessages(true)
      try {
        const res = await fetchApi<{ success: boolean; data: MessageLog[] }>(
          `/api/friends/${friendId}/messages`
        )
        if (res.success) setMessages(res.data)
      } catch { /* silent */ }
      setLoadingMessages(false)
    }
    loadMessages()
  }, [friendId])

  const handleSend = async () => {
    if (!message.trim() || sending || sendLockRef.current) return
    sendLockRef.current = true
    setSending(true)
    try {
      await fetchApi(`/api/friends/${friendId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: message, messageType: 'text' }),
      })
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        direction: 'outgoing',
        messageType: 'text',
        content: message,
        createdAt: new Date().toISOString(),
      }])
      setMessage('')
    } catch { /* silent */ }
    setSending(false)
    sendLockRef.current = false
  }

  function renderContent(msg: MessageLog) {
    if (msg.messageType === 'text') return msg.content
    if (msg.messageType === 'flex') {
      try {
        const parsed = JSON.parse(msg.content)
        // Extract ALL text from flex (up to 200 chars)
        const texts: string[] = []
        const collectText = (obj: Record<string, unknown>) => {
          if (texts.join(' ').length > 200) return
          if (obj.type === 'text' && typeof obj.text === 'string') {
            const t = (obj.text as string).trim()
            if (t && !t.startsWith('{{')) texts.push(t)
          }
          for (const key of ['header', 'body', 'footer']) {
            if (obj[key]) collectText(obj[key] as Record<string, unknown>)
          }
          if (Array.isArray(obj.contents)) {
            for (const c of obj.contents) collectText(c as Record<string, unknown>)
          }
        }
        collectText(parsed)
        return texts.slice(0, 4).join('\n') || '[Flex Message]'
      } catch { return '[Flex Message]' }
    }
    if (msg.messageType === 'sticker') {
      return <StickerMessageImage content={msg.content} />
    }
    return `[${msg.messageType}]`
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4 border-b border-gray-200 flex items-center gap-3">
        <button onClick={onBack} className="lg:hidden text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {friend?.pictureUrl ? (
          <img src={friend.pictureUrl} alt="" className="w-8 h-8 rounded-full" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 text-xs">{(friend?.displayName || '?').charAt(0)}</span>
          </div>
        )}
        <div>
          <p className="text-sm font-bold text-gray-900">{friend?.displayName || '不明'}</p>
          <p className="text-xs text-gray-400">メッセージ履歴</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loadingMessages ? (
          <p className="text-center text-gray-400 text-sm">読み込み中...</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-gray-400 text-sm">メッセージ履歴がありません</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                msg.direction === 'outgoing'
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-100 text-gray-900'
              }`}>
                <div className="text-sm whitespace-pre-wrap break-words">{renderContent(msg)}</div>
                <p className={`text-xs mt-1 ${msg.direction === 'outgoing' ? 'text-green-200' : 'text-gray-400'}`}>
                  {new Date(msg.createdAt).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="px-4 py-3 border-t border-gray-200">
        <div className="flex gap-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onCompositionStart={() => { isComposingRef.current = true }}
            onCompositionEnd={() => { isComposingRef.current = false }}
            onKeyDown={(e) => {
              // IME変換確定のEnterでは送信しない
              if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="メッセージを入力..."
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
          />
          <button
            onClick={handleSend}
            disabled={!message.trim() || sending}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50 bg-brand-600 hover:bg-brand-700"
          >
            {sending ? '...' : '送信'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ChatsPage() {
  const { selectedAccountId } = useAccount()
  const { confirm: confirmDialog } = useConfirm()
  const [chats, setChats] = useState<Chat[]>([])
  const [allFriends, setAllFriends] = useState<FriendItem[]>([])
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null)
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const statusFilterRef = useRef<StatusFilter>('all')
  const unansweredOnlyRef = useRef(false)
  // 「自分の担当」ビュー。myStaffId が判明するまでは無効のまま (共有 API キー
  // 運用ではトグル自体を出さない)。既定は「全員が全件を眺める状態が一番詰まる」
  // という判断から ON。ユーザーが変更したら localStorage に覚える。
  // 全チャット横断検索。ON の間は一覧を検索結果に差し替える。
  const [globalSearchMode, setGlobalSearchMode] = useState(false)
  const [globalSearchQuery, setGlobalSearchQuery] = useState('')
  const [globalSearchResults, setGlobalSearchResults] = useState<SearchHit[]>([])
  const [globalSearching, setGlobalSearching] = useState(false)
  const [globalSearchError, setGlobalSearchError] = useState('')

  // 会話内検索。開いているチャットの中だけを検索する。
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatSearchQuery, setChatSearchQuery] = useState('')
  const [chatSearchResults, setChatSearchResults] = useState<SearchHit[]>([])
  const [chatSearching, setChatSearching] = useState(false)
  const [chatSearchError, setChatSearchError] = useState('')

  const [myChatsOnly, setMyChatsOnly] = useState(() => {
    if (typeof window === 'undefined') return false
    // ?operator= 付きで来た場合 (チーム状況からの遷移) は担当者フィルタを
    // 効かせたいので「自分の担当」トグルは初期OFFにする
    if (new URLSearchParams(window.location.search).get('operator')) return false
    const stored = window.localStorage.getItem('lh_chat_my_view')
    return stored === null ? true : stored === '1'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('lh_chat_my_view', myChatsOnly ? '1' : '0')
  }, [myChatsOnly])
  const [unansweredOnly, setUnansweredOnly] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('unanswered') === '1'
  })

  // unansweredOnly 変更時に URL を書き戻す
  useEffect(() => {
    if (typeof window === 'undefined') return
    const urlParams = new URLSearchParams(window.location.search)
    if (unansweredOnly) urlParams.set('unanswered', '1')
    else urlParams.delete('unanswered')
    const qs = urlParams.toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(null, '', url)
  }, [unansweredOnly])
  // Send mode: 'enter' = Enter sends, Shift+Enter = newline; 'shift-enter' = reverse
  const [sendMode, setSendMode] = useState<'enter' | 'shift-enter'>('enter')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMoreChats, setHasMoreChats] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [messageContent, setMessageContent] = useState('')
  const [pendingImage, setPendingImage] = useState<ImageUploaderValue | null>(null)
  const [sending, setSending] = useState(false)
  const sendLockRef = useRef(false)
  const [chatNotes, setChatNotes] = useState<ChatNote[]>([])
  const [newNoteContent, setNewNoteContent] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [invitingTelegram, setInvitingTelegram] = useState(false)
  const [invitingDiscord, setInvitingDiscord] = useState(false)
  const [snoozing, setSnoozing] = useState(false)
  // クイック返信チップ: text型テンプレートの新しい順5件をワンタップ挿入
  const [quickReplies, setQuickReplies] = useState<{ id: string; name: string; content: string }[]>([])

  useEffect(() => {
    let cancelled = false
    api.templates
      .list()
      .then((res) => {
        if (cancelled || !res.success) return
        setQuickReplies(
          res.data
            .filter((t) => t.messageType === 'text')
            .slice(0, 5)
            .map((t) => ({ id: t.id, name: t.name, content: t.messageContent })),
        )
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const [myStaffId, setMyStaffId] = useState<string | null>(null)
  const [myRole, setMyRole] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [claimingNext, setClaimingNext] = useState(false)
  // 担当者ID→名前の解決用名簿 (全ロールで呼べる /api/staff/roster)。
  // 一覧の担当バッジ・詳細の「◯◯が担当」表示・担当者フィルタに使う。
  const [staffRoster, setStaffRoster] = useState<{ id: string; name: string; isActive: boolean }[]>([])
  // '' = 全員 / 'none' = 未割当のみ / それ以外 = スタッフID。
  // チーム状況ページからの遷移 (?operator=<id|none>) を初期値として受ける。
  const [operatorFilter, setOperatorFilter] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('operator') ?? ''
  })
  // 表示上のチャネル絞り込み。クライアント側で読み込み済み chats を絞るだけ (API は変更しない)。
  const [channelFilter, setChannelFilter] = useState<'all' | 'line' | 'telegram'>('all')
  // スレッドヘッダーの二次操作をまとめる「その他」メニューの開閉。
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  // 送信欄の詳細設定 (入力中ローディング・送信キー) の開閉。
  const [composerSettingsOpen, setComposerSettingsOpen] = useState(false)

  const staffNameOf = useCallback(
    (id: string | null | undefined): string | null => {
      if (!id) return null
      return staffRoster.find((s) => s.id === id)?.name ?? '不明なスタッフ'
    },
    [staffRoster],
  )

  // 「自分の担当か」の判定に使う。共有 API キーでログインしている場合は
  // staff_members 行が無いので null のままになり、担当ボタンは出さない。
  useEffect(() => {
    let cancelled = false
    api.staff
      .me()
      .then((res) => {
        if (!cancelled) {
          setMyStaffId(res.success ? res.data.id : null)
          setMyRole(res.success ? res.data.role : null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMyStaffId(null)
          setMyRole(null)
        }
      })
    api.staff
      .roster()
      .then((res) => {
        if (!cancelled && res.success) setStaffRoster(res.data)
      })
      .catch(() => {
        // 名簿が取れなくても致命的ではない (担当バッジがID非表示になるだけ)
      })
    return () => {
      cancelled = true
    }
  }, [])
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(5)
  const lastLoadingTriggerAtRef = useRef<Record<string, number>>({})
  const [isMessageInputFocused, setIsMessageInputFocused] = useState(false)
  const isComposingRef = useRef(false)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    try {
      const rawEnabled = localStorage.getItem(SHOW_LOADING_PREF_KEY)
      const rawSeconds = localStorage.getItem(LOADING_SECONDS_PREF_KEY)
      if (rawEnabled !== null) setShowLoadingIndicator(rawEnabled === '1')
      if (rawSeconds) {
        const n = Number.parseInt(rawSeconds, 10)
        if (Number.isFinite(n) && n >= 5 && n <= 60) setLoadingSeconds(n)
      }
    } catch {
      // localStorage unavailable
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SHOW_LOADING_PREF_KEY, showLoadingIndicator ? '1' : '0')
      localStorage.setItem(LOADING_SECONDS_PREF_KEY, String(loadingSeconds))
    } catch {
      // localStorage unavailable
    }
  }, [showLoadingIndicator, loadingSeconds])

  // ページング用カーソル。表示リストは楽観更新で並び替わるため、
  // 「サーバから最後に受け取った行」を ref で保持して次ページの起点にする
  // (offset 方式だと新着で行が押し下げられた分が欠落する)。
  const nextCursorRef = useRef<{ at: string; id: string } | null>(null)

  const buildListParams = useCallback((cursor: { at: string; id: string } | null) => {
    const params: {
      status?: string; operatorId?: string; accountId?: string; unansweredOnly?: boolean;
      limit?: number; beforeAt?: string; beforeId?: string;
    } = {}
    if (statusFilter !== 'all' && !unansweredOnly) params.status = statusFilter
    // 「自分の担当」トグルが優先。OFF のときだけ担当者ドロップダウン
    // ('none'=未割当 / スタッフID) が効く。
    if (myChatsOnly && myStaffId) params.operatorId = myStaffId
    else if (operatorFilter) params.operatorId = operatorFilter
    if (selectedAccountId) params.accountId = selectedAccountId
    if (unansweredOnly) params.unansweredOnly = true
    else params.limit = CHAT_PAGE_SIZE
    if (cursor) {
      params.beforeAt = cursor.at
      params.beforeId = cursor.id
    }
    return params
  }, [statusFilter, selectedAccountId, unansweredOnly, myChatsOnly, myStaffId, operatorFilter])

  const loadChats = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const chatRes = await api.chats.list(buildListParams(null))
      if (chatRes.success) {
        const rows = chatRes.data as unknown as Chat[]
        setChats(rows)
        const last = rows[rows.length - 1]
        nextCursorRef.current = last?.lastMessageAt ? { at: last.lastMessageAt, id: last.id } : null
        // ページ丁度いっぱい返ってきた = 続きがある可能性が高い (unansweredOnly は全件返る)
        setHasMoreChats(!unansweredOnly && rows.length === CHAT_PAGE_SIZE)
      }
    } catch {
      setError('チャットの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [buildListParams, unansweredOnly])

  // 「さらに読み込む」— サーバ由来カーソルの続きを取得して末尾に追加する。
  // 楽観更新との競合に備えて既存 id は除外し、重複表示を防ぐ。
  const loadMoreChats = useCallback(async () => {
    if (loadingMore) return
    const cursor = nextCursorRef.current
    if (!cursor) {
      setHasMoreChats(false)
      return
    }
    setLoadingMore(true)
    try {
      const chatRes = await api.chats.list(buildListParams(cursor))
      if (chatRes.success) {
        const rows = chatRes.data as unknown as Chat[]
        setChats((prev) => {
          const seen = new Set(prev.map((c) => c.id))
          return [...prev, ...rows.filter((r) => !seen.has(r.id))]
        })
        const last = rows[rows.length - 1]
        nextCursorRef.current = last?.lastMessageAt ? { at: last.lastMessageAt, id: last.id } : null
        setHasMoreChats(rows.length === CHAT_PAGE_SIZE)
      }
    } catch {
      setError('チャットの追加読み込みに失敗しました。')
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, buildListParams])

  // Friends list (for the "new direct message" modal) — loaded lazily in the background
  // Previously fetched 800 friends in parallel with chats, which blocked the initial render.
  const loadAllFriends = useCallback(async () => {
    try {
      const friendRes = await api.friends.list({ accountId: selectedAccountId || undefined, limit: '800' })
      if (friendRes.success) {
        setAllFriends((friendRes.data as unknown as { items: FriendItem[] }).items)
      }
    } catch { /* silent */ }
  }, [selectedAccountId])

  useEffect(() => { void loadAllFriends() }, [loadAllFriends])

  // Keep refs in sync so setChats updater can read the latest filter without stale closure
  useEffect(() => { statusFilterRef.current = statusFilter }, [statusFilter])
  useEffect(() => { unansweredOnlyRef.current = unansweredOnly }, [unansweredOnly])

  // Load/save sendMode preference (guarded — privacy-restricted browsers throw)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('chat.sendMode')
      if (saved === 'enter' || saved === 'shift-enter') setSendMode(saved)
    } catch { /* localStorage unavailable */ }
  }, [])
  useEffect(() => {
    try { localStorage.setItem('chat.sendMode', sendMode) } catch { /* ignore */ }
  }, [sendMode])

  const loadChatDetail = useCallback(async (chatId: string) => {
    setDetailLoading(true)
    setError('')
    try {
      const res = await api.chats.get(chatId)
      if (res.success) {
        setChatDetail(res.data as unknown as ChatDetail)
        api.chats.listNotes(chatId)
          .then((notesRes) => { if (notesRes.success) setChatNotes(notesRes.data) })
          .catch(() => {})
      } else {
        // API は 200 で success:false を返す可能性 (例: 404 lookup)。詳細を画面に出す。
        const errMsg = (res as { error?: string }).error ?? '不明なエラー'
        setError(`チャット詳細の読み込みに失敗しました: ${errMsg}`)
      }
    } catch (err) {
      // ネットワーク / parse / auth fail などの例外。empty catch だと原因不明だったので詳細を出す。
      const msg = err instanceof Error ? err.message : String(err)
      setError(`チャット詳細の読み込みに失敗しました: ${msg}`)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  // 軽量ポーリング (081): タブ表示中のみ30秒ごとに一覧だけ再取得し、新着 (LINE/
  // Telegram) を手動更新なしで反映する。開いているスレッド (chatDetail) は
  // 触らないので、返信の入力・スクロールを妨げない。
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        loadChats()
      }
    }, 30_000)
    return () => clearInterval(id)
  }, [loadChats])

  // Deep-link from other pages (e.g. /form-submissions): ?friend=<friendId>
  // chat list returns id = friend_id, so selectedChatId === friendId is correct.
  // If no chat exists yet, loadChatDetail will fail and the user can fall back to
  // the friend list — acceptable for now.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const friendId = params.get('friend')
    if (friendId) setSelectedChatId(friendId)
  }, [])

  useEffect(() => {
    if (selectedChatId) {
      loadChatDetail(selectedChatId)
    } else {
      setChatDetail(null)
    }
  }, [selectedChatId, loadChatDetail])

  // Surface deep-linked chats in the sidebar even when the current account
  // filter or status filter would exclude them — otherwise the user replies
  // and the conversation stays invisible until they refresh.
  // Re-runs when `chats` changes (e.g. after loadChats refetches on filter
  // change) so the synthetic entry is re-injected if the next API result
  // does not include it. Returning `prev` unchanged when already present
  // avoids any update loop.
  useEffect(() => {
    if (!chatDetail) return
    setChats((prev) => {
      if (prev.some((c) => c.id === chatDetail.id)) return prev
      // /api/chats/:id may not populate the lastMessage* fields; derive
      // from the messages array as a fallback so the sidebar preview is
      // not stuck on "(まだメッセージなし)".
      const lastMsg = chatDetail.messages?.[chatDetail.messages.length - 1]
      const entry: Chat = {
        id: chatDetail.id,
        friendId: chatDetail.friendId,
        friendName: chatDetail.friendName,
        friendPictureUrl: chatDetail.friendPictureUrl,
        operatorId: chatDetail.operatorId ?? null,
        status: chatDetail.status,
        outcome: chatDetail.outcome ?? null,
        source: chatDetail.source ?? null,
        channel: chatDetail.channel ?? 'line',
        telegramUserId: chatDetail.telegramUserId ?? null,
        discordUserId: chatDetail.discordUserId ?? null,
        version: chatDetail.version ?? 0,
        notes: chatDetail.notes ?? null,
        lastMessageAt: chatDetail.lastMessageAt ?? lastMsg?.createdAt ?? null,
        lastMessageContent: chatDetail.lastMessageContent ?? lastMsg?.content ?? null,
        lastMessageDirection: chatDetail.lastMessageDirection ?? lastMsg?.direction ?? null,
        lastMessageType: chatDetail.lastMessageType ?? lastMsg?.messageType ?? null,
        createdAt: chatDetail.createdAt,
        updatedAt: chatDetail.updatedAt,
      }
      return [entry, ...prev]
    })
  }, [chatDetail, chats])

  // 詳細が新しくロードされたら最下部（＝最新メッセージ）までスクロールする。
  // そこから上にスクロールすれば過去のメッセージを辿れる（LINE受信画面と同じUX）。
  // ユーザーが手動でスクロールしたら delayed auto-scroll は発動させない。
  useEffect(() => {
    if (!chatDetail?.messages || chatDetail.messages.length === 0) return
    const el = messagesScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    let userScrolled = false
    const onScroll = () => {
      if (!messagesScrollRef.current) return
      const current = messagesScrollRef.current
      // 下端から一定以上離れたらユーザー操作とみなす
      if (current.scrollHeight - current.scrollTop - current.clientHeight > 20) {
        userScrolled = true
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // 画像/Flex の表示後に高さが増える場合に追従するフォロワー（ユーザーがスクロール済みなら発動させない）
    const id = window.setTimeout(() => {
      if (userScrolled || !messagesScrollRef.current) return
      messagesScrollRef.current.scrollTop = messagesScrollRef.current.scrollHeight
    }, 150)
    return () => {
      window.clearTimeout(id)
      el.removeEventListener('scroll', onScroll)
    }
  }, [chatDetail?.id, chatDetail?.messages?.length])

  // Auto-resize textarea as messageContent grows
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [messageContent])

  const handleSelectChat = (chatId: string) => {
    setSelectedChatId(chatId)
    setMessageContent('')
    setPendingImage(null)
  }

  const triggerLoadingAnimation = useCallback(async (chatId: string) => {
    if (!showLoadingIndicator) return

    const now = Date.now()
    const last = lastLoadingTriggerAtRef.current[chatId] ?? 0
    if (now - last < LOADING_REFRESH_INTERVAL_MS) return
    lastLoadingTriggerAtRef.current[chatId] = now

    try {
      await fetchApi<{ success: boolean }>(`/api/chats/${chatId}/loading`, {
        method: 'POST',
        body: JSON.stringify({ loadingSeconds }),
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown'
      setError(`ローディング表示の開始に失敗しました: ${detail}`)
    }
  }, [showLoadingIndicator, loadingSeconds])

  const handleSendMessage = async () => {
    if (!selectedChatId || sending || sendLockRef.current) return
    if (!messageContent.trim() && !pendingImage) return
    const sendingChatId = selectedChatId  // capture the chat id for this send
    sendLockRef.current = true
    setSending(true)
    try {
      const now = new Date().toISOString()
      // --- Image send path (runs first when image is present) ---
      if (pendingImage && pendingImage.mode === 'line-image') {
        const imgPayload = JSON.stringify({
          originalContentUrl: pendingImage.originalContentUrl,
          previewImageUrl: pendingImage.previewImageUrl,
        })
        await api.chats.send(sendingChatId, { messageType: 'image', content: imgPayload })
        setPendingImage(null)
        // Optimistic update for image
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          messages: [
            ...(prev.messages ?? []),
            {
              id: crypto.randomUUID(),
              direction: 'outgoing',
              messageType: 'image',
              content: imgPayload,
              createdAt: now,
            },
          ],
        } : prev)
        setChats((prev) => {
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          const currentFilter = statusFilterRef.current
          const currentUnansweredOnly = unansweredOnlyRef.current
          const updated = prev.map((c) => c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            lastMessageContent: '[画像]',
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'image' as const,
          } : c)
          // 未対応モード時は status filter を skip (worker 側で status を絞ってないため
          // 楽観更新で applied するとリストが歪む — Codex Round 1)
          let filtered = currentUnansweredOnly
            ? updated
            : (currentFilter === 'all' ? updated : updated.filter((c) => c.status === currentFilter))
          if (currentUnansweredOnly) {
            // 未対応モードでは、自分が返信したばかりの chat はもう未対応ではないのでリストから除外
            filtered = filtered.filter((c) => c.id !== sendingChatId)
          }
          return [...filtered].sort((a, b) => {
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
          })
        })
      }
      // --- Text send path (runs independently — both paths execute when both image and text are present) ---
      if (messageContent.trim()) {
        const content = messageContent.trim()
        await api.chats.send(sendingChatId, { content, expectedVersion: chatDetail?.version })
        setMessageContent('')
        // Optimistic update: append message locally instead of refetching (prevents scroll jump / full reload feel)
        // Only mutate chatDetail if it still corresponds to the chat we just sent to
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          messages: [
            ...(prev.messages ?? []),
            {
              id: crypto.randomUUID(),
              direction: 'outgoing',
              messageType: 'text',
              content,
              createdAt: now,
            },
          ],
        } : prev)
        setChats((prev) => {
          // Skip reconciliation if the list no longer contains this chat (e.g. tab changed mid-send)
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          const currentFilter = statusFilterRef.current
          const currentUnansweredOnly = unansweredOnlyRef.current
          const updated = prev.map((c) => c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            // 一覧の preview も即時更新する。server 側も direction/source を問わず
            // 実際の最新メッセージを返すため、次回 loadChats() 後も同じ表示になる。
            lastMessageContent: content,
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'text' as const,
          } : c)
          // Drop rows that no longer match the current tab (e.g. replying from 未読 moves chat to in_progress)
          // 未対応モード時は status filter を skip (worker 側で status を絞ってないため
          // 楽観更新で applied するとリストが歪む — Codex Round 1)
          let filtered = currentUnansweredOnly
            ? updated
            : (currentFilter === 'all' ? updated : updated.filter((c) => c.status === currentFilter))
          if (currentUnansweredOnly) {
            // 未対応モードでは、自分が返信したばかりの chat はもう未対応ではないのでリストから除外
            filtered = filtered.filter((c) => c.id !== sendingChatId)
          }
          return [...filtered].sort((a, b) => {
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
          })
        })
      }
      // 手動返信で未対応が 1 件減るので、サイドバーのバッジを即時更新させる
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch {
      setError('メッセージの送信に失敗しました。')
    } finally {
      setSending(false)
      sendLockRef.current = false
    }
  }

  const handleStatusUpdate = async (newStatus: Chat['status']) => {
    if (!selectedChatId) return
    try {
      await api.chats.update(selectedChatId, { status: newStatus })
      loadChatDetail(selectedChatId)
      loadChats()
      // 解決済/未読の切替は未対応バッジに影響するので即時更新させる
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch {
      setError('ステータスの更新に失敗しました。')
    }
  }

  // 未割当のチャットは「担当する」を踏むまで送信できない。踏ませることが
  // 二重返信を防ぐ要点なので、ボタンだけでなく入力欄自体をロックする。
  // 共有 API キー運用 (myStaffId=null) では担当の概念が無いのでロックしない。
  const composerLocked = Boolean(myStaffId) && chatDetail?.operatorId === null

  // 3文字未満は trigram インデックスの制約でヒットしないため (Worker 側も
  // 同じ基準で 400 を返す)、クライアント側でも同じ閾値でフェッチを止める。
  const MIN_SEARCH_LENGTH = 3

  useEffect(() => {
    if (!globalSearchMode) return
    const q = globalSearchQuery.trim()
    if (q.length < MIN_SEARCH_LENGTH) {
      setGlobalSearchResults([])
      setGlobalSearchError('')
      return
    }
    let cancelled = false
    setGlobalSearching(true)
    const timer = setTimeout(async () => {
      try {
        const res = await api.messages.search(q, { limit: 50 })
        if (cancelled) return
        if (res.success) {
          setGlobalSearchResults(res.data)
          setGlobalSearchError('')
        } else {
          setGlobalSearchResults([])
          setGlobalSearchError((res as { error?: string }).error ?? '検索に失敗しました')
        }
      } catch {
        if (!cancelled) {
          setGlobalSearchResults([])
          setGlobalSearchError('検索に失敗しました')
        }
      } finally {
        if (!cancelled) setGlobalSearching(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [globalSearchMode, globalSearchQuery])

  useEffect(() => {
    if (!chatSearchOpen || !selectedChatId) return
    const q = chatSearchQuery.trim()
    if (q.length < MIN_SEARCH_LENGTH) {
      setChatSearchResults([])
      setChatSearchError('')
      return
    }
    let cancelled = false
    setChatSearching(true)
    const timer = setTimeout(async () => {
      try {
        const res = await api.messages.search(q, { friendId: selectedChatId, limit: 50 })
        if (cancelled) return
        if (res.success) {
          setChatSearchResults(res.data)
          setChatSearchError('')
        } else {
          setChatSearchResults([])
          setChatSearchError((res as { error?: string }).error ?? '検索に失敗しました')
        }
      } catch {
        if (!cancelled) {
          setChatSearchResults([])
          setChatSearchError('検索に失敗しました')
        }
      } finally {
        if (!cancelled) setChatSearching(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [chatSearchOpen, chatSearchQuery, selectedChatId])

  const handleClaim = async (force = false) => {
    if (!selectedChatId) return
    if (force && !(await confirmDialog({ title: '担当の引き取り', message: '他のスタッフが担当中です。引き取りますか？', confirmLabel: '引き取る' }))) return
    setClaiming(true)
    try {
      await api.chats.claim(selectedChatId, { force })
      loadChatDetail(selectedChatId)
      loadChats()
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      setError(
        status === 409
          ? '他のスタッフが先に担当になりました。画面を更新してください。'
          : status === 400
            ? '共有 API キーでは担当者になれません。スタッフとしてログインしてください。'
            : `担当の設定に失敗しました (HTTP ${status || '不明'})。`,
      )
      if (status === 409) loadChatDetail(selectedChatId)
    } finally {
      setClaiming(false)
    }
  }

  const handleOutcomeUpdate = async (value: string) => {
    if (!selectedChatId) return
    try {
      await api.chats.update(selectedChatId, {
        outcome: value === '' ? null : (value as NonNullable<Chat['outcome']>),
      })
      loadChatDetail(selectedChatId)
      loadChats()
    } catch {
      setError('成果の更新に失敗しました。')
    }
  }

  // プル型分配: 未対応キューの先頭 (hot優先→最古) を原子的に自分の担当にして開く
  const handleClaimNext = async () => {
    setClaimingNext(true)
    setError('')
    try {
      const res = await api.chats.claimNext()
      if (res.success) {
        if (res.data) {
          await loadChats()
          handleSelectChat(res.data.friendId)
          window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
        } else {
          setError('未割当の未対応チャットはありません 🎉')
        }
      }
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      setError(
        status === 400
          ? '共有 API キーでは担当者になれません。スタッフとしてログインしてください。'
          : `次の未対応の取得に失敗しました (HTTP ${status || '不明'})。`,
      )
    } finally {
      setClaimingNext(false)
    }
  }

  const handleRelease = async () => {
    if (!selectedChatId) return
    if (!(await confirmDialog({ title: '担当の解除', message: '担当を外して未割当に戻しますか？', confirmLabel: '外す' }))) return
    setClaiming(true)
    try {
      await api.chats.release(selectedChatId)
      loadChatDetail(selectedChatId)
      loadChats()
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      setError(
        status === 403
          ? '他のスタッフの担当は外せません (admin/owner のみ可能です)。'
          : status === 409
            ? '他のスタッフが先に更新しました。画面を更新してください。'
            : `担当の解除に失敗しました (HTTP ${status || '不明'})。`,
      )
    } finally {
      setClaiming(false)
    }
  }

  // スヌーズのプリセット。'clear' は解除
  const handleSnooze = async (preset: string) => {
    if (!selectedChatId || !preset) return
    let until: string | null = null
    const now = new Date()
    if (preset === '1h') until = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    else if (preset === 'tomorrow9') {
      const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0)
      until = d.toISOString()
    } else if (preset === '3days9') {
      const d = new Date(now); d.setDate(d.getDate() + 3); d.setHours(9, 0, 0, 0)
      until = d.toISOString()
    } else if (preset !== 'clear') return
    setSnoozing(true)
    try {
      await api.chats.snooze(selectedChatId, until)
      loadChatDetail(selectedChatId)
      loadChats()
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      setError(`再連絡予約に失敗しました (HTTP ${status || '不明'})。`)
    } finally {
      setSnoozing(false)
    }
  }

  const handleAssign = async (staffId: string) => {
    if (!selectedChatId || !staffId) return
    setClaiming(true)
    try {
      await api.chats.assign(selectedChatId, staffId)
      loadChatDetail(selectedChatId)
      loadChats()
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      setError(
        status === 403
          ? '担当の割り当ては admin/owner のみ可能です。'
          : `担当の割り当てに失敗しました (HTTP ${status || '不明'})。`,
      )
    } finally {
      setClaiming(false)
    }
  }

  const handleInviteTelegram = async () => {
    if (!selectedChatId) return
    if (!(await confirmDialog({ title: 'Telegram誘導', message: 'このユーザーに Telegram 誘導リンクを LINE で送りますか？', confirmLabel: '送信する' }))) return
    setInvitingTelegram(true)
    try {
      await api.chats.inviteTelegram(selectedChatId)
      // 送信内容がトーク履歴に出るので、詳細を取り直して TG バッジも更新する
      loadChatDetail(selectedChatId)
      loadChats()
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      setError(
        status === 400
          ? 'この友だちは既に Telegram と連携済みです。'
          : `Telegram 誘導リンクの送信に失敗しました (HTTP ${status || '不明'})。`,
      )
    } finally {
      setInvitingTelegram(false)
    }
  }

  const handleInviteDiscord = async () => {
    if (!selectedChatId) return
    if (!(await confirmDialog({ title: 'Discord誘導', message: 'このユーザーに Discord 誘導リンクを LINE で送りますか？', confirmLabel: '送信する' }))) return
    setInvitingDiscord(true)
    try {
      await api.chats.inviteDiscord(selectedChatId)
      loadChatDetail(selectedChatId)
      loadChats()
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      setError(
        status === 400
          ? 'この友だちは既に Discord と連携済みです。'
          : `Discord 誘導リンクの送信に失敗しました (HTTP ${status || '不明'})。`,
      )
    } finally {
      setInvitingDiscord(false)
    }
  }

  const handleAddNote = async () => {
    if (!selectedChatId || !newNoteContent.trim()) return
    setAddingNote(true)
    try {
      const res = await api.chats.addNote(selectedChatId, newNoteContent.trim())
      if (res.success) {
        setChatNotes((prev) => [...prev, res.data])
        setNewNoteContent('')
      }
    } catch {
      setError('メモの追加に失敗しました。')
    } finally {
      setAddingNote(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // IME変換確定のEnterでは送信しない
    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
    if (e.key !== 'Enter') return
    // sendMode 'enter': Enter単体で送信、Shift+Enterは改行
    // sendMode 'shift-enter': Shift+Enterで送信、Enter単体は改行
    const shouldSend = sendMode === 'enter' ? !e.shiftKey : e.shiftKey
    if (shouldSend) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div>
      <Header title="オペレーターチャット" />

      {/* Error */}
      {error && (
        error.includes('🎉') ? (
          <div className="mb-4 p-4 bg-brand-50 border border-brand-100 rounded-lg text-brand-700 text-sm">
            {error}
          </div>
        ) : (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )
      )}

      <div className="flex gap-4 h-[calc(100vh-120px)] lg:h-[calc(100vh-180px)]">
        {/* Left Panel: Chat List */}
        <div className={`w-full lg:w-96 lg:flex-shrink-0 bg-surface rounded-xl shadow-sm border border-edge flex-col overflow-hidden ${selectedChatId ? 'hidden lg:flex' : 'flex'}`}>
          {/* Sticky header: 検索 + フィルタ (「一覧が探しにくい」への対処) */}
          <div className="flex-shrink-0 border-b border-edge">
            {/* 全チャット横断検索。ON の間は下の一覧を検索結果に差し替える。 */}
            <div className="p-3 pb-2">
              <div className="relative">
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
                <input
                  type="text"
                  value={globalSearchQuery}
                  onChange={(e) => {
                    setGlobalSearchQuery(e.target.value)
                    if (!globalSearchMode) setGlobalSearchMode(true)
                  }}
                  onFocus={() => setGlobalSearchMode(true)}
                  placeholder="メッセージを検索 (3文字以上)"
                  aria-label="全チャットからメッセージを検索"
                  className="w-full text-sm bg-surface-alt/60 border border-edge rounded-lg pl-9 pr-9 py-2 text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-surface"
                />
                {globalSearchMode && (
                  <button
                    onClick={() => { setGlobalSearchMode(false); setGlobalSearchQuery(''); setGlobalSearchResults([]) }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-ink-faint hover:text-ink hover:bg-surface-alt"
                    aria-label="検索を閉じる"
                  >
                    <Icon name="close" className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* チャネル絞り込み (クライアント側のみ・API は変更しない) */}
            <div className="px-3 pb-2">
              <div className="flex items-center gap-1 rounded-lg bg-surface-alt p-0.5">
                {([
                  { key: 'all', label: 'すべて' },
                  { key: 'line', label: 'LINE' },
                  { key: 'telegram', label: 'Telegram' },
                ] as const).map((c) => (
                  <button
                    key={c.key}
                    onClick={() => setChannelFilter(c.key)}
                    aria-pressed={channelFilter === c.key}
                    className={`flex-1 inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                      channelFilter === c.key ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {c.key === 'line' && <span className="w-1.5 h-1.5 rounded-full bg-line" aria-hidden="true" />}
                    {c.key === 'telegram' && <span className="w-1.5 h-1.5 rounded-full bg-sky-500" aria-hidden="true" />}
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ステータスフィルタ + 未対応のみ */}
            <div className="px-3 pb-2 flex flex-wrap items-center gap-1.5">
              {statusFilters.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  disabled={unansweredOnly}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    statusFilter === f.key
                      ? 'bg-brand-600 text-white'
                      : 'bg-surface-alt text-ink-muted hover:bg-edge'
                  } ${unansweredOnly ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  {f.label}
                </button>
              ))}
              <label className="flex items-center gap-1.5 text-xs font-medium text-ink-muted whitespace-nowrap ml-auto cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={unansweredOnly}
                  onChange={(e) => setUnansweredOnly(e.target.checked)}
                  className="rounded accent-brand-600"
                />
                未対応のみ
              </label>
            </div>

            {/* 担当フィルタ + プル型分配 */}
            <div className="px-3 pb-3 flex flex-wrap items-center gap-2">
              {/* 共有 API キー運用 (myStaffId 不明) では担当の概念が無いので出さない */}
              {myStaffId && (
                <label className="flex items-center gap-1.5 text-xs font-medium text-ink-muted whitespace-nowrap cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={myChatsOnly}
                    onChange={(e) => setMyChatsOnly(e.target.checked)}
                    className="rounded accent-brand-600"
                  />
                  自分の担当
                </label>
              )}
              {/* 担当者フィルタ。「自分の担当」ON中は競合するため無効化 */}
              {staffRoster.length > 0 && (
                <select
                  value={myChatsOnly ? '' : operatorFilter}
                  onChange={(e) => setOperatorFilter(e.target.value)}
                  disabled={myChatsOnly}
                  className={`text-xs border border-edge rounded-lg px-2 py-1 bg-surface text-ink ${myChatsOnly ? 'opacity-40 cursor-not-allowed' : ''}`}
                  title="担当者で絞り込む"
                >
                  <option value="">担当: 全員</option>
                  <option value="none">担当: 未割当のみ</option>
                  {staffRoster.filter((s) => s.isActive).map((s) => (
                    <option key={s.id} value={s.id}>担当: {s.name}</option>
                  ))}
                </select>
              )}
              {/* プル型分配: 未割当の未対応から次の1件を取る。同時に押しても
                  原子的claimにより別々のチャットが割り当たる */}
              {myStaffId && (
                <Button
                  size="sm"
                  onClick={() => { void handleClaimNext() }}
                  disabled={claimingNext}
                  className="ml-auto"
                  title="未割当の未対応 (HOTリード優先・古い順) から次の1件を自分の担当にして開く"
                >
                  <Icon name="rocket" className="w-3.5 h-3.5" />
                  {claimingNext ? '取得中…' : '次の未対応を担当'}
                </Button>
              )}
            </div>
          </div>

          {/* Chat List */}
          <div className="flex-1 overflow-y-auto bg-surface">
            {globalSearchMode ? (
              globalSearchQuery.trim().length < MIN_SEARCH_LENGTH ? (
                <div className="px-4 py-8 text-center text-xs text-ink-faint">
                  {MIN_SEARCH_LENGTH}文字以上入力すると検索します
                </div>
              ) : globalSearching ? (
                <div className="px-4 py-8 text-center text-xs text-ink-faint">検索中...</div>
              ) : globalSearchError ? (
                <div className="px-4 py-8 text-center text-xs text-danger">{globalSearchError}</div>
              ) : globalSearchResults.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-ink-faint">一致するメッセージがありません</div>
              ) : (
                globalSearchResults.map((hit) => (
                  <button
                    key={hit.id}
                    onClick={() => {
                      setGlobalSearchMode(false)
                      setGlobalSearchQuery('')
                      setSelectedFriendId(null)
                      handleSelectChat(hit.friendId)
                    }}
                    className="w-full text-left px-4 py-3 border-b border-edge hover:bg-surface-alt focus-visible:outline-none focus-visible:bg-surface-alt"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-ink truncate">{hit.friendName}</p>
                      <span className="text-[10px] text-ink-faint flex-shrink-0">{formatDatetime(hit.createdAt)}</span>
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5 line-clamp-2">
                      {hit.direction === 'outgoing' && <span className="text-ink-faint mr-1">↪</span>}
                      {hit.content}
                    </p>
                  </button>
                ))
              )
            ) : loading ? (
              <div>
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="px-4 py-3 border-b border-edge animate-pulse">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-full bg-surface-alt flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-surface-alt rounded w-32" />
                        <div className="h-2 bg-surface-alt rounded w-40" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (() => {
              // チャネル絞り込みは読み込み済み chats に対するクライアント側フィルタのみ。
              // サーバのページングには一切干渉しない (hasMoreChats は chats 全体基準のまま)。
              const visibleChats = channelFilter === 'all'
                ? chats
                : chats.filter((c) => c.channel === channelFilter)
              if (visibleChats.length === 0) {
                return (
                  <EmptyState
                    icon={<Icon name="chat" className="w-6 h-6" />}
                    title="チャットがありません"
                    description={
                      channelFilter !== 'all'
                        ? 'このチャネルの会話はまだありません。上のタブで「すべて」に戻せます。'
                        : 'フィルタ条件に一致する会話がありません。'
                    }
                  />
                )
              }
              return (
                <>
                  {visibleChats.map((chat) => {
                    const isSelected = selectedChatId === chat.id
                    // 「真の自発（要対応）」= chat.status='unread'。webhook 側で auto_reply に
                    // マッチしなかった incoming のみ unread に設定される。auto_reply trigger
                    // (キーワード "コスト比較" 等) は matched 扱いで unread 化しない。
                    // bold / 🟥 の表示はこの status を使う。direction だけだと button 押下も
                    // 強調してしまって S/N 比が悪化する。
                    const needsAttention = chat.status === 'unread'
                    // 最新メッセージの本文 preview。flex/image は文字列で見せても意味が薄いので type 表記に置換。
                    const previewRaw = chat.lastMessageContent ?? ''
                    const preview = (() => {
                      if (chat.lastMessageType === 'image') return '[画像]'
                      if (chat.lastMessageType === 'flex') return '[Flexメッセージ]'
                      if (chat.lastMessageType === 'sticker') return '[スタンプ]'
                      if (chat.lastMessageType === 'video') return '[動画]'
                      if (chat.lastMessageType === 'audio') return '[音声]'
                      if (chat.lastMessageType === 'file') return '[ファイル]'
                      if (chat.lastMessageType === 'location') return '[位置情報]'
                      return previewRaw.replace(/\n+/g, ' ').slice(0, 60)
                    })()
                    return (
                      <button
                        key={chat.id}
                        onClick={() => { setSelectedFriendId(null); handleSelectChat(chat.id); }}
                        aria-current={isSelected && !selectedFriendId ? 'true' : undefined}
                        className={`w-full text-left pl-3 pr-4 py-3 border-b border-edge border-l-2 transition-colors focus-visible:outline-none ${
                          isSelected && !selectedFriendId
                            ? 'bg-brand-50 border-l-brand-600'
                            : 'border-l-transparent hover:bg-surface-alt focus-visible:bg-surface-alt'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="relative flex-shrink-0">
                            {chat.friendPictureUrl ? (
                              <img src={chat.friendPictureUrl} alt="" className="w-11 h-11 rounded-full object-cover" />
                            ) : (
                              <div className="w-11 h-11 rounded-full bg-surface-alt flex items-center justify-center">
                                <span className="text-ink-muted text-base font-medium">{chat.friendName.charAt(0)}</span>
                              </div>
                            )}
                            {/* チャネル識別ドット (アバター右下)。LINE=緑 / Telegram=スカイ */}
                            <span
                              className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full ring-2 ring-surface ${
                                chat.channel === 'telegram' ? 'bg-sky-500' : 'bg-line'
                              }`}
                              aria-hidden="true"
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                {chat.status === 'unread' && (
                                  <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" aria-label="未読" />
                                )}
                                <p className={`text-sm truncate ${needsAttention ? 'font-bold text-ink' : 'font-medium text-ink'}`}>
                                  {chat.friendName}
                                </p>
                                {chat.channel === 'telegram' && (
                                  <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-700 font-medium">Telegram</span>
                                )}
                              </div>
                              <span className={`text-[10px] flex-shrink-0 ${needsAttention ? 'text-brand-600 font-medium' : 'text-ink-faint'}`}>
                                {formatRelativeTime(chat.lastMessageAt)}
                              </span>
                            </div>
                            <p
                              className={`text-xs mt-0.5 truncate ${
                                needsAttention ? 'text-ink font-medium' : 'text-ink-muted'
                              }`}
                              title={preview}
                            >
                              {chat.lastMessageDirection === 'outgoing' && (
                                <span className="text-ink-faint mr-1">↪</span>
                              )}
                              {preview || <span className="italic text-ink-faint">(まだメッセージなし)</span>}
                            </p>
                            {(chat.source || chat.telegramUserId || chat.outcome || staffRoster.length > 0) && (
                              <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                                {/* 担当バッジ: 自分=青 / 他スタッフ=青(実名) / 未割当=グレー */}
                                {staffRoster.length > 0 && (
                                  chat.operatorId ? (
                                    <span
                                      className={`px-1.5 py-0.5 text-[10px] rounded ${
                                        chat.operatorId === myStaffId
                                          ? 'bg-brand-50 text-brand-700'
                                          : 'bg-brand-50 text-brand-700'
                                      }`}
                                      title={`担当: ${staffNameOf(chat.operatorId)}`}
                                    >
                                      {chat.operatorId === myStaffId ? '自分' : staffNameOf(chat.operatorId)}
                                    </span>
                                  ) : (
                                    <span className="px-1.5 py-0.5 text-[10px] rounded bg-surface-alt text-ink-muted">
                                      未割当
                                    </span>
                                  )
                                )}
                                {chat.source && (
                                  <span
                                    className="px-1.5 py-0.5 text-[10px] rounded bg-violet-50 text-violet-700"
                                    title={`流入元: ${chat.source}`}
                                  >
                                    {chat.source}
                                  </span>
                                )}
                                {chat.telegramUserId && (
                                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-sky-50 text-sky-700">
                                    TG
                                  </span>
                                )}
                                {chat.outcome && (
                                  <span
                                    className={`px-1.5 py-0.5 text-[10px] rounded ${
                                      chat.outcome === 'converted'
                                        ? 'bg-emerald-50 text-emerald-700'
                                        : 'bg-surface-alt text-ink-muted'
                                    }`}
                                  >
                                    {chat.outcome === 'converted' ? '成約' : '離脱'}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                  {hasMoreChats && !unansweredOnly && (
                    <button
                      onClick={() => { void loadMoreChats() }}
                      disabled={loadingMore}
                      className="w-full px-4 py-3 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 border-b border-edge"
                    >
                      {loadingMore ? '読み込み中...' : 'さらに読み込む'}
                    </button>
                  )}
                </>
              )
            })()}
          </div>
        </div>

        {/* Right Panel: Chat Detail */}
        <div className={`flex-1 min-w-0 bg-surface rounded-xl shadow-sm border border-edge flex-col overflow-hidden ${selectedChatId || selectedFriendId ? 'flex' : 'hidden lg:flex'}`}>
          {selectedFriendId && !selectedChatId ? (
            /* Direct message to friend without existing chat */
            <DirectMessagePanel
              friendId={selectedFriendId}
              friend={allFriends.find((f) => f.id === selectedFriendId) || null}
              onBack={() => setSelectedFriendId(null)}
              onSent={() => { setSelectedFriendId(null); loadChats(); }}
            />
          ) : !selectedChatId ? (
            <EmptyState
              className="flex-1"
              icon={<Icon name="chat" className="w-6 h-6" />}
              title="チャットを選択してください"
              description="左の一覧から会話を選ぶと、ここにやり取りが表示されます。"
            />
          ) : detailLoading ? (
            <LoadingState className="flex-1" />
          ) : chatDetail ? (
            <>
              {/* Chat Header — 主要操作 (対応状況/担当) はインライン、二次操作は「その他」メニューへ集約 */}
              <div className="px-3 sm:px-4 py-2.5 border-b border-edge flex items-center justify-between gap-2 bg-surface">
                <div className="flex items-center gap-2.5 min-w-0">
                  <button
                    onClick={() => setSelectedChatId(null)}
                    className="lg:hidden flex-shrink-0 flex items-center justify-center w-9 h-9 -ml-1 rounded-lg text-ink-muted hover:bg-surface-alt hover:text-ink"
                    aria-label="一覧に戻る"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  {chatDetail.friendPictureUrl ? (
                    <img src={chatDetail.friendPictureUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0 object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-surface-alt flex items-center justify-center flex-shrink-0">
                      <span className="text-ink-muted text-base font-medium">{chatDetail.friendName.charAt(0)}</span>
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-semibold text-ink truncate">
                        {chatDetail.friendName}
                      </p>
                      <ChannelBadge channel={(chats.find((c) => c.id === chatDetail.id)?.channel ?? chatDetail.channel) === 'telegram' ? 'telegram' : 'line'} />
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${statusConfig[chatDetail.status].className}`}
                      >
                        {statusConfig[chatDetail.status].label}
                      </span>
                      {chatDetail.snoozeUntil && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-orange-700" title="この時刻に未対応として再浮上します">
                          <Icon name="clock" className="w-3 h-3" />
                          {new Date(chatDetail.snoozeUntil).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {unansweredOnly && chats.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        const idx = chats.findIndex((c) => c.id === selectedChatId)
                        // idx < 0 = current chat is no longer in the list (e.g. just sent a reply)
                        // → fall back to the head of the list so the queue keeps moving
                        const nextIdx = idx < 0 ? 0 : (idx + 1) % chats.length
                        const next = chats[nextIdx]
                        if (next && next.id !== selectedChatId) {
                          setSelectedChatId(next.id)
                        }
                      }}
                      className="hidden sm:inline-flex rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
                      title="次の未対応 friend に進む"
                    >
                      次の未対応 →
                    </button>
                  )}
                  {/* 進行状態 (対応状況)。最頻用なのでインライン維持 */}
                  <select
                    value={chatDetail.status}
                    onChange={(e) => handleStatusUpdate(e.target.value as Chat['status'])}
                    className="px-2 py-1.5 text-xs font-medium border border-edge rounded-lg bg-surface text-ink"
                    aria-label="進行状態"
                  >
                    {progressOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {/* 担当 (Claim)。複数スタッフが同じキューを見る運用で二重返信を防ぐ。
                      共有 API キーでログイン中 (myStaffId=null) は担当者になれない。 */}
                  {myStaffId && chatDetail.operatorId === null && (
                    <button
                      onClick={() => handleClaim(false)}
                      disabled={claiming}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
                      title="このチャットを自分の担当にする"
                    >
                      {claiming ? '設定中…' : '担当する'}
                    </button>
                  )}
                  {myStaffId && chatDetail.operatorId === myStaffId && (
                    <span className="inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-brand-700 bg-brand-50 rounded-lg whitespace-nowrap">
                      自分が担当
                      <button
                        onClick={() => { void handleRelease() }}
                        disabled={claiming}
                        className="ml-0.5 text-brand-600 hover:text-brand-800 underline disabled:opacity-50"
                        title="担当を外して未割当に戻す"
                      >
                        外す
                      </button>
                    </span>
                  )}
                  {myStaffId && chatDetail.operatorId !== null && chatDetail.operatorId !== myStaffId && (
                    <button
                      onClick={() => handleClaim(true)}
                      disabled={claiming}
                      className="px-3 py-1.5 text-xs font-medium text-orange-700 bg-orange-50 hover:bg-orange-100 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
                      title={`${staffNameOf(chatDetail.operatorId) ?? '他のスタッフ'}が担当中です`}
                    >
                      {claiming
                        ? '設定中…'
                        : `${staffNameOf(chatDetail.operatorId) ?? '他スタッフ'} — 引き取る`}
                    </button>
                  )}
                  {/* その他メニュー: 検索・成果・再連絡・担当変更・誘導リンクをまとめる (ボタンが多すぎ問題への対処) */}
                  <div className="relative">
                    <button
                      onClick={() => setActionsMenuOpen((v) => !v)}
                      aria-haspopup="menu"
                      aria-expanded={actionsMenuOpen}
                      aria-label="その他の操作"
                      className={`inline-flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
                        actionsMenuOpen ? 'bg-surface-alt text-ink' : 'text-ink-muted hover:bg-surface-alt hover:text-ink'
                      }`}
                      title="その他の操作"
                    >
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="12" cy="5" r="1.6" />
                        <circle cx="12" cy="12" r="1.6" />
                        <circle cx="12" cy="19" r="1.6" />
                      </svg>
                    </button>
                    {actionsMenuOpen && (
                      <>
                        <button
                          type="button"
                          aria-hidden="true"
                          tabIndex={-1}
                          onClick={() => setActionsMenuOpen(false)}
                          className="fixed inset-0 z-10 cursor-default"
                        />
                        <div
                          role="menu"
                          className="absolute right-0 top-full mt-1 z-20 w-64 max-h-[70vh] overflow-y-auto rounded-xl border border-edge bg-surface shadow-lg p-1.5"
                        >
                          {/* 会話内検索 */}
                          <button
                            role="menuitem"
                            onClick={() => {
                              setChatSearchOpen((v) => !v)
                              if (chatSearchOpen) { setChatSearchQuery(''); setChatSearchResults([]) }
                              setActionsMenuOpen(false)
                            }}
                            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-ink hover:bg-surface-alt"
                          >
                            <Icon name="search" className="w-4 h-4 text-ink-muted" />
                            {chatSearchOpen ? '会話内検索を閉じる' : '会話内を検索'}
                          </button>

                          <div className="my-1 border-t border-edge" />

                          {/* 成果 */}
                          <div className="px-2.5 py-1.5">
                            <label className="block text-[11px] font-medium text-ink-muted mb-1">成果</label>
                            <select
                              value={chatDetail.outcome ?? ''}
                              onChange={(e) => handleOutcomeUpdate(e.target.value)}
                              className="w-full text-sm border border-edge rounded-lg px-2 py-1.5 bg-surface text-ink"
                              aria-label="成果"
                            >
                              {outcomeOptions.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* 再連絡 (スヌーズ)。期日に未対応として再浮上する */}
                          <div className="px-2.5 py-1.5">
                            <label className="block text-[11px] font-medium text-ink-muted mb-1">再連絡予約</label>
                            {chatDetail.snoozeUntil ? (
                              <div className="flex items-center justify-between gap-2 text-xs text-orange-700">
                                <span className="inline-flex items-center gap-1">
                                  <Icon name="clock" className="w-3.5 h-3.5" />
                                  {new Date(chatDetail.snoozeUntil).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} に再浮上
                                </span>
                                <button
                                  onClick={() => { void handleSnooze('clear') }}
                                  disabled={snoozing}
                                  className="text-brand-600 hover:text-brand-800 underline disabled:opacity-50"
                                >
                                  解除
                                </button>
                              </div>
                            ) : (
                              <select
                                value=""
                                onChange={(e) => { void handleSnooze(e.target.value) }}
                                disabled={snoozing}
                                className="w-full text-sm border border-edge rounded-lg px-2 py-1.5 bg-surface text-ink disabled:opacity-50"
                                title="指定した時刻に未対応として再浮上させる (返信待ちの放置防止)"
                              >
                                <option value="">再連絡…</option>
                                <option value="1h">1時間後</option>
                                <option value="tomorrow9">明日 9:00</option>
                                <option value="3days9">3日後 9:00</option>
                              </select>
                            )}
                          </div>

                          {/* admin/owner は任意のスタッフへ割り当て(再割当)できる */}
                          {(myRole === 'owner' || myRole === 'admin') && staffRoster.length > 0 && (
                            <div className="px-2.5 py-1.5">
                              <label className="block text-[11px] font-medium text-ink-muted mb-1">担当を変更 (管理者)</label>
                              <select
                                value=""
                                onChange={(e) => { if (e.target.value) void handleAssign(e.target.value) }}
                                disabled={claiming}
                                className="w-full text-sm border border-edge rounded-lg px-2 py-1.5 bg-surface text-ink disabled:opacity-50"
                                title="このチャットをスタッフに割り当てる (admin/owner のみ)"
                              >
                                <option value="">担当を変更…</option>
                                {staffRoster.filter((s) => s.isActive).map((s) => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                              </select>
                            </div>
                          )}

                          <div className="my-1 border-t border-edge" />

                          {/* 誘導リンク (LINE で送信するため line 系ボタン) */}
                          <div className="px-2.5 py-1.5 space-y-1.5">
                            {chatDetail.telegramUserId ? (
                              <div
                                className="flex items-center gap-1.5 text-xs font-medium text-sky-700"
                                title={chatDetail.tgVerifiedAt ? `連携日時: ${chatDetail.tgVerifiedAt}` : undefined}
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-sky-500" aria-hidden="true" /> Telegram 連携済
                              </div>
                            ) : (
                              <Button
                                variant="line"
                                size="sm"
                                onClick={() => { void handleInviteTelegram(); setActionsMenuOpen(false) }}
                                disabled={invitingTelegram}
                                className="w-full"
                                title="Telegram 誘導リンクを LINE で送る (24時間で失効)"
                              >
                                {invitingTelegram ? '送信中…' : 'Telegramに誘導する'}
                              </Button>
                            )}
                            {chatDetail.discordUserId ? (
                              <div
                                className="flex items-center gap-1.5 text-xs font-medium text-violet-700"
                                title={chatDetail.discordVerifiedAt ? `連携日時: ${chatDetail.discordVerifiedAt}` : undefined}
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-violet-500" aria-hidden="true" /> Discord 連携済
                              </div>
                            ) : (
                              <Button
                                variant="line"
                                size="sm"
                                onClick={() => { void handleInviteDiscord(); setActionsMenuOpen(false) }}
                                disabled={invitingDiscord}
                                className="w-full"
                                title="Discord 誘導リンクを LINE で送る (24時間で失効)"
                              >
                                {invitingDiscord ? '送信中…' : 'Discordに誘導する'}
                              </Button>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* 会話内検索パネル。過去の全履歴 (画面に表示されている直近分に限らない)
                  を対象に、本文の全文検索結果をプレビュー表示する。トランスクリプトへの
                  ジャンプは行わない (表示中の履歴を超えた古いメッセージもヒットし得るため)。 */}
              {chatSearchOpen && (
                <div className="px-4 py-3 border-b border-edge bg-surface-alt">
                  <input
                    type="text"
                    autoFocus
                    value={chatSearchQuery}
                    onChange={(e) => setChatSearchQuery(e.target.value)}
                    placeholder={`この会話の中を検索 (${MIN_SEARCH_LENGTH}文字以上)`}
                    className="w-full text-sm border border-edge rounded-lg px-3 py-2 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  {chatSearchQuery.trim().length >= MIN_SEARCH_LENGTH && (
                    <div className="mt-2 max-h-48 overflow-y-auto space-y-1.5">
                      {chatSearching ? (
                        <p className="text-xs text-ink-faint">検索中...</p>
                      ) : chatSearchError ? (
                        <p className="text-xs text-danger">{chatSearchError}</p>
                      ) : chatSearchResults.length === 0 ? (
                        <p className="text-xs text-ink-faint">一致するメッセージがありません</p>
                      ) : (
                        chatSearchResults.map((hit) => (
                          <div key={hit.id} className="text-xs bg-surface border border-edge rounded-md px-2.5 py-1.5">
                            <span className="text-ink-faint">{formatDatetime(hit.createdAt)}</span>
                            <p className="text-ink mt-0.5">
                              {hit.direction === 'outgoing' && <span className="text-ink-faint mr-1">↪</span>}
                              {hit.content}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Messages — チャットアプリ風のバブル (受信=左/グレー, 送信=右/ブランド青) */}
              <div ref={messagesScrollRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 space-y-1 bg-app">
                {(!chatDetail.messages || chatDetail.messages.length === 0) ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-ink-faint text-sm">メッセージはまだありません。</p>
                  </div>
                ) : (
                  (chatDetail.messages ?? []).map((msg, idx) => {
                    const prevMsg = idx > 0 ? (chatDetail.messages ?? [])[idx - 1] : null
                    const showDateSep = !prevMsg || !sameYmd(prevMsg.createdAt, msg.createdAt)
                    const isOutgoing = msg.direction === 'outgoing'
                    const isMedia = msg.messageType === 'image' || msg.messageType === 'sticker' || msg.messageType === 'flex'

                    // メッセージ表示の分岐
                    let bubbleContent: React.ReactNode
                    if (msg.messageType === 'flex') {
                      bubbleContent = (
                        <div className="max-w-[300px]">
                          <FlexPreviewComponent content={msg.content} maxWidth={280} />
                        </div>
                      )
                    } else if (msg.messageType === 'image') {
                      try {
                        const parsed = JSON.parse(msg.content)
                        bubbleContent = (
                          <img src={parsed.originalContentUrl || parsed.previewImageUrl} alt="" className="max-w-[200px] rounded-lg" />
                        )
                      } catch {
                        bubbleContent = <span>[画像]</span>
                      }
                    } else if (msg.messageType === 'sticker') {
                      bubbleContent = <StickerMessageImage content={msg.content} />
                    } else {
                      bubbleContent = <span>{msg.content}</span>
                    }

                    return (
                      <div key={msg.id}>
                        {showDateSep && (
                          <div className="flex justify-center my-3">
                            <span className="text-[11px] font-medium text-ink-muted bg-surface-alt px-2.5 py-0.5 rounded-full">
                              {formatYmdSlash(msg.createdAt)}
                            </span>
                          </div>
                        )}
                        <div
                          className={`flex items-end gap-2 py-0.5 ${isOutgoing ? 'justify-end' : 'justify-start'}`}
                        >
                          {/* 相手のアイコン（incoming のみ） */}
                          {!isOutgoing && (
                            chatDetail.friendPictureUrl ? (
                              <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mb-4 object-cover" />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-surface-alt flex-shrink-0 mb-4 flex items-center justify-center text-ink-muted text-xs font-medium">
                                {chatDetail.friendName.charAt(0)}
                              </div>
                            )
                          )}

                          <div className={`flex flex-col max-w-[78%] ${isOutgoing ? 'items-end' : 'items-start'}`}>
                            {/* メッセージバブル。メディアは余白/背景を抑える */}
                            <div
                              className={`text-sm break-words whitespace-pre-wrap shadow-sm ${
                                isMedia ? 'p-1' : 'px-3 py-2'
                              } ${
                                isOutgoing
                                  ? 'rounded-2xl rounded-br-sm bg-brand-600 text-white'
                                  : 'rounded-2xl rounded-bl-sm bg-surface-alt text-ink'
                              }`}
                            >
                              {bubbleContent}
                            </div>
                            {/* 時刻 */}
                            <span className="text-[10px] text-ink-faint mt-0.5 px-1">
                              {new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              {/* Notes — 時系列・追記専用。複数スタッフの同時対応で上書きし合わないよう、
                  誰が・いつ・何を書いたかを残す (旧: 上書き式の1行メモ)。 */}
              <div className="px-4 py-2 border-t border-edge bg-surface-alt">
                {chatNotes.length > 0 && (
                  <div className="max-h-28 overflow-y-auto mb-2 space-y-1">
                    {chatNotes.map((n) => (
                      <div key={n.id} className="text-xs bg-surface border border-edge rounded-md px-2 py-1">
                        <span className="font-medium text-ink-muted">{n.staffName ?? '(不明)'}</span>
                        <span className="text-ink-faint mx-1">·</span>
                        <span className="text-ink-faint">{formatDatetime(n.createdAt)}</span>
                        <p className="text-ink whitespace-pre-wrap break-words">{n.content}</p>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="flex-shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-ink-faint">
                    <Icon name="clipboard" className="w-3.5 h-3.5" /> 社内メモ
                  </span>
                  <input
                    type="text"
                    value={newNoteContent}
                    onChange={(e) => setNewNoteContent(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleAddNote()
                    }}
                    placeholder="メモを入力... (相手には送信されません)"
                    className="flex-1 text-xs border border-edge rounded-lg px-2 py-1.5 bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <button
                    onClick={handleAddNote}
                    disabled={addingNote || !newNoteContent.trim()}
                    className="px-2.5 py-1.5 text-xs font-medium text-ink-muted bg-surface border border-edge hover:bg-surface-alt rounded-lg transition-colors disabled:opacity-50"
                  >
                    {addingNote ? '追加中...' : '追加'}
                  </button>
                </div>
              </div>

              {/* Composer — 未割当時はロックせず「担当する」を促すインラインプロンプトを出す */}
              {composerLocked ? (
                <div className="border-t border-edge bg-surface p-4">
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                    <div className="flex items-center gap-2 text-sm text-amber-800 min-w-0">
                      <Icon name="lock" className="w-4 h-4 flex-shrink-0" />
                      <span className="min-w-0">このチャットは未割当です。担当すると返信できます。</span>
                    </div>
                    <button
                      onClick={() => handleClaim(false)}
                      disabled={claiming}
                      className="flex-shrink-0 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {claiming ? '設定中…' : '担当する'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="border-t border-edge bg-surface px-3 sm:px-4 py-3">
                  {/* クイック返信チップ: text型テンプレートの新しい順5件をワンタップ挿入。
                      タップで本文に追記し、フォーカスを返信欄へ移す */}
                  {quickReplies.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {quickReplies.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setMessageContent((prev) => (prev ? `${prev}\n${t.content}` : t.content))
                            textareaRef.current?.focus()
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full border border-edge bg-surface-alt text-ink-muted hover:bg-brand-50 hover:border-brand-300 hover:text-brand-700 transition-colors max-w-[180px] truncate"
                          title={t.content}
                        >
                          <Icon name="template" className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{t.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {/* 画像添付 (LINE/Telegram 共通で text + image のみ対応) */}
                  <div className="mb-2">
                    <ImageUploader
                      mode="line-image"
                      value={pendingImage}
                      onChange={setPendingImage}
                      label="画像を送る (任意)"
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <textarea
                      ref={textareaRef}
                      rows={1}
                      value={messageContent}
                      style={{ maxHeight: '200px', overflowY: 'auto' }}
                      onChange={(e) => {
                        const value = e.target.value
                        setMessageContent(value)
                        if (selectedChatId && isMessageInputFocused && value.trim()) {
                          void triggerLoadingAnimation(selectedChatId)
                        }
                      }}
                      onCompositionStart={() => { isComposingRef.current = true }}
                      onCompositionEnd={() => { isComposingRef.current = false }}
                      onFocus={() => {
                        setIsMessageInputFocused(true)
                        if (selectedChatId) {
                          void triggerLoadingAnimation(selectedChatId)
                        }
                      }}
                      onBlur={() => setIsMessageInputFocused(false)}
                      onKeyDown={handleKeyDown}
                      disabled={composerLocked}
                      placeholder={composerLocked ? '「担当する」を押すと入力できます' : 'メッセージを入力...'}
                      className="flex-1 min-h-[44px] text-sm border border-edge rounded-2xl px-3.5 py-2.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none overflow-y-auto disabled:bg-surface-alt disabled:cursor-not-allowed"
                    />
                    <button
                      onClick={handleSendMessage}
                      disabled={composerLocked || sending || (!messageContent.trim() && !pendingImage)}
                      aria-label="送信"
                      className="flex-shrink-0 inline-flex items-center gap-1.5 px-4 min-h-[44px] text-sm font-medium text-white rounded-2xl transition-colors bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Icon name="reply" className="w-4 h-4 -scale-x-100" />
                      {sending ? '送信中...' : '送信'}
                    </button>
                  </div>
                  {/* 送信設定 (折りたたみ)。入力中ローディングは LINE 専用なので Telegram では隠す */}
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setComposerSettingsOpen((v) => !v)}
                      aria-expanded={composerSettingsOpen}
                      className="inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink-muted"
                    >
                      <Icon name="chevron-down" className={`w-3 h-3 transition-transform ${composerSettingsOpen ? 'rotate-180' : ''}`} />
                      送信設定
                    </button>
                    {composerSettingsOpen && (
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-muted">
                        {(chats.find((c) => c.id === chatDetail.id)?.channel ?? chatDetail.channel) !== 'telegram' && (
                          <>
                            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={showLoadingIndicator}
                                onChange={(e) => setShowLoadingIndicator(e.target.checked)}
                                className="h-4 w-4 rounded border-edge text-brand-600 focus:ring-brand-500"
                              />
                              入力中ローディングを表示
                            </label>
                            <select
                              value={loadingSeconds}
                              onChange={(e) => setLoadingSeconds(Number.parseInt(e.target.value, 10))}
                              disabled={!showLoadingIndicator}
                              className="border border-edge rounded-lg px-2 py-1 bg-surface text-ink disabled:bg-surface-alt disabled:text-ink-faint"
                            >
                              {[5, 10, 15, 20, 30, 45, 60].map((sec) => (
                                <option key={sec} value={sec}>{sec}秒</option>
                              ))}
                            </select>
                          </>
                        )}
                        <span className="text-ink-faint">送信キー:</span>
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input
                            type="radio"
                            checked={sendMode === 'enter'}
                            onChange={() => setSendMode('enter')}
                            className="accent-brand-600"
                          />
                          <span>Enter</span>
                        </label>
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input
                            type="radio"
                            checked={sendMode === 'shift-enter'}
                            onChange={() => setSendMode('shift-enter')}
                            className="accent-brand-600"
                          />
                          <span>Shift+Enter</span>
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Right-most Panel: 友だち詳細サイドバー — chat detail を開いている時のみ表示 */}
        {/*
          friendId は **現在の selection** を優先する。chatDetail の load 中は前の chat
          のデータが残ったままなので、それを参照するとサイドバーだけ前の友だちを
          表示し続けて pane 間の不整合になる。selection ID 自体が friend_id なので
          直接渡せる (chat list SQL が `id: f.id` で friend_id を返す)。
        */}
        {(selectedChatId || selectedFriendId) && (
          <div className="hidden xl:flex">
            <FriendInfoSidebar
              friendId={selectedFriendId || selectedChatId}
              chatStatus={
                chatDetail && chatDetail.id === (selectedFriendId || selectedChatId)
                  ? { status: chatDetail.status, notes: chatDetail.notes }
                  : undefined
              }
              operatorName={
                chatDetail && chatDetail.id === (selectedFriendId || selectedChatId)
                  ? staffNameOf(chatDetail.operatorId)
                  : null
              }
            />
          </div>
        )}
      </div>
      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}
