'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import Header from '@/components/layout/header'
import { api } from '@/lib/api'

const POLL_INTERVAL_MS = 30_000
const COLUMN_LIMIT = 30

type BoardStatus = 'unread' | 'in_progress' | 'waiting_reply' | 'resolved'

// GET /api/chats の一覧行 (共有 Chat 型には一覧専用の friendName 等が無いため
// chats/page.tsx と同様にローカル定義する)
interface Chat {
  id: string
  friendId: string
  friendName: string
  operatorId: string | null
  status: BoardStatus
  channel?: 'line' | 'telegram'
  lastMessageAt: string | null
  lastMessageContent: string | null
}

const COLUMNS: Array<{ status: BoardStatus; label: string; accent: string }> = [
  { status: 'unread', label: '未読', accent: 'border-t-red-400' },
  { status: 'in_progress', label: '対応中', accent: 'border-t-blue-400' },
  { status: 'waiting_reply', label: '返信待ち', accent: 'border-t-amber-400' },
  { status: 'resolved', label: '完了', accent: 'border-t-emerald-400' },
]

function formatElapsed(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'たった今'
  if (min < 60) return `${min}分前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}時間前`
  return `${Math.floor(hr / 24)}日前`
}

function BoardCard({
  chat,
  operatorName,
  isMine,
  onOpen,
}: {
  chat: Chat
  operatorName: string | null
  isMine: boolean
  onOpen: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: chat.id })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      className={`bg-white rounded-lg border border-gray-200 p-3 cursor-grab active:cursor-grabbing shadow-sm hover:shadow transition-shadow ${isDragging ? 'opacity-40' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{chat.friendName}</p>
          {chat.channel === 'telegram' && (
            <span className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded-full bg-sky-50 text-sky-700 font-medium">TG</span>
          )}
        </div>
        <span className="text-[10px] text-gray-400 whitespace-nowrap">{formatElapsed(chat.lastMessageAt)}</span>
      </div>
      <p className="text-xs text-gray-500 truncate mt-1">
        {chat.lastMessageContent || <span className="italic text-gray-300">(メッセージなし)</span>}
      </p>
      <div className="mt-1.5">
        {chat.operatorId ? (
          <span className={`px-1.5 py-0.5 text-[10px] rounded ${isMine ? 'bg-brand-50 text-brand-700' : 'bg-blue-50 text-blue-700'}`}>
            {isMine ? '自分' : operatorName}
          </span>
        ) : (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-500">未割当</span>
        )}
      </div>
    </div>
  )
}

function BoardColumn({
  status,
  label,
  accent,
  children,
  count,
}: {
  status: BoardStatus
  label: string
  accent: string
  children: React.ReactNode
  count: number
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <div
      ref={setNodeRef}
      className={`flex-1 min-w-[240px] bg-gray-50 rounded-lg border border-gray-200 border-t-4 ${accent} ${isOver ? 'ring-2 ring-brand-400 bg-brand-50/50' : ''}`}
    >
      <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
        <span className="text-sm font-bold text-gray-700">{label}</span>
        <span className="text-xs text-gray-400 tabular-nums">{count}</span>
      </div>
      <div className="p-2 space-y-2 min-h-[120px] max-h-[calc(100vh-260px)] overflow-y-auto">
        {children}
      </div>
    </div>
  )
}

export default function BoardPage() {
  const [columns, setColumns] = useState<Record<BoardStatus, Chat[]>>({
    unread: [], in_progress: [], waiting_reply: [], resolved: [],
  })
  const [staffRoster, setStaffRoster] = useState<{ id: string; name: string; isActive: boolean }[]>([])
  const [myStaffId, setMyStaffId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeChat, setActiveChat] = useState<Chat | null>(null)
  const [claimingNext, setClaimingNext] = useState(false)
  const router = useRouter()

  // クリックとドラッグを区別する (8px 動かすまではクリック扱い)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const load = useCallback(async () => {
    try {
      const [unread, inProgress, waitingReply, resolved] = await Promise.all(
        (['unread', 'in_progress', 'waiting_reply', 'resolved'] as BoardStatus[]).map((status) =>
          api.chats.list({ status, limit: COLUMN_LIMIT }),
        ),
      )
      const pick = (res: typeof unread) => (res.success ? (res.data as unknown as Chat[]) : [])
      setColumns({
        unread: pick(unread),
        in_progress: pick(inProgress),
        waiting_reply: pick(waitingReply),
        resolved: pick(resolved),
      })
      setError('')
    } catch {
      setError('取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    api.staff.roster().then((res) => { if (res.success) setStaffRoster(res.data) }).catch(() => {})
    api.staff.me().then((res) => setMyStaffId(res.success ? res.data.id : null)).catch(() => setMyStaffId(null))
    const id = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [load])

  const nameOf = (id: string | null) =>
    id ? (staffRoster.find((s) => s.id === id)?.name ?? '不明なスタッフ') : null

  const findChat = (id: string): { chat: Chat; from: BoardStatus } | null => {
    for (const col of COLUMNS) {
      const chat = columns[col.status].find((c) => c.id === id)
      if (chat) return { chat, from: col.status }
    }
    return null
  }

  const handleDragStart = (event: DragStartEvent) => {
    const found = findChat(String(event.active.id))
    setActiveChat(found?.chat ?? null)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveChat(null)
    const { active, over } = event
    if (!over) return
    const to = over.id as BoardStatus
    const found = findChat(String(active.id))
    if (!found || found.from === to) return

    // 楽観更新: 先にUIを動かし、失敗したら再読込で戻す
    setColumns((prev) => ({
      ...prev,
      [found.from]: prev[found.from].filter((c) => c.id !== found.chat.id),
      [to]: [{ ...found.chat, status: to }, ...prev[to]],
    }))
    try {
      await api.chats.update(found.chat.id, { status: to })
    } catch {
      setError('状態の変更に失敗しました。最新の状態に戻します。')
      void load()
    }
  }

  const handleClaimNext = async () => {
    setClaimingNext(true)
    setError('')
    try {
      const res = await api.chats.claimNext()
      if (res.success) {
        if (res.data) router.push(`/chats?friend=${encodeURIComponent(res.data.friendId)}`)
        else setError('未割当の未対応チャットはありません 🎉')
      }
    } catch {
      setError('次の未対応の取得に失敗しました')
    } finally {
      setClaimingNext(false)
    }
  }

  return (
    <div>
      <Header
        title="チャットボード"
        description="進行状況を列で俯瞰し、カードをドラッグして状態を変更できます。カードをクリックするとチャットが開きます。"
        action={
          myStaffId ? (
            <button
              onClick={() => { void handleClaimNext() }}
              disabled={claimingNext}
              className="px-4 py-2 min-h-[44px] rounded-lg text-white text-sm font-medium disabled:opacity-50 bg-brand-600 hover:bg-brand-700"
            >
              {claimingNext ? '取得中…' : '次の未対応を担当'}
            </button>
          ) : undefined
        }
      />

      {error && (
        error.includes('🎉') ? (
          <div className="rounded-lg border border-brand-100 bg-brand-50 p-3 text-sm text-brand-700 mb-4">{error}</div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 mb-4">{error}</div>
        )
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">読み込み中...</div>
      ) : (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="flex gap-3 overflow-x-auto pb-4">
            {COLUMNS.map((col) => (
              <BoardColumn
                key={col.status}
                status={col.status}
                label={col.label}
                accent={col.accent}
                count={columns[col.status].length}
              >
                {columns[col.status].length === 0 ? (
                  <p className="text-xs text-gray-300 text-center py-6">なし</p>
                ) : (
                  columns[col.status].map((chat) => (
                    <BoardCard
                      key={chat.id}
                      chat={chat}
                      operatorName={nameOf(chat.operatorId)}
                      isMine={chat.operatorId !== null && chat.operatorId === myStaffId}
                      onOpen={() => router.push(`/chats?friend=${encodeURIComponent(chat.id)}`)}
                    />
                  ))
                )}
              </BoardColumn>
            ))}
          </div>
          <DragOverlay>
            {activeChat && (
              <div className="bg-white rounded-lg border-2 border-brand-400 p-3 shadow-lg w-[240px]">
                <p className="text-sm font-medium text-gray-900 truncate">{activeChat.friendName}</p>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
      <p className="text-xs text-gray-400 mt-2">
        各列は最新{COLUMN_LIMIT}件まで表示。30秒ごとに自動更新されます。担当の変更はカードを開いて行ってください。
      </p>
    </div>
  )
}
