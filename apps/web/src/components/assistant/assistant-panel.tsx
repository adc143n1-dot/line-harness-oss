'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { Icon } from '@/components/ui/icons'
import MarkdownLite from '@/components/ui/markdown-lite'
import { Spinner } from '@/components/ui/spinner'

interface Msg { role: 'user' | 'assistant'; content: string }

const SUGGESTIONS = [
  '今の状況をまとめて',
  '未対応を減らすには?',
  '個別チャットの使い方は?',
  'Telegramを始めるには?',
]

// 管理画面のどこからでも呼べるAIアシスタント。app-shell に1回だけ配置する。
export default function AssistantPanel() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, open, sending])

  const send = async (text: string) => {
    const question = text.trim()
    if (!question || sending) return
    setError('')
    // 直近の履歴(今回の質問より前)をサーバーに渡す
    const history = messages.slice(-12)
    setMessages((prev) => [...prev, { role: 'user', content: question }])
    setInput('')
    setSending(true)
    try {
      const res = await api.assistant.ask({ question, history })
      if (res.success) {
        setMessages((prev) => [...prev, { role: 'assistant', content: res.data.answer }])
      } else {
        setError(res.error)
      }
    } catch {
      setError('通信に失敗しました。')
    }
    setSending(false)
  }

  return (
    <>
      {/* FAB */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="AIアシスタントを開く"
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-full bg-brand-600 hover:bg-brand-700 text-white shadow-lg transition-colors"
        >
          <Icon name="sparkles" className="w-5 h-5" />
          <span className="text-sm font-medium hidden sm:inline">AIアシスタント</span>
        </button>
      )}

      {/* パネル */}
      {open && (
        <div className="fixed inset-0 z-50 sm:inset-auto sm:bottom-6 sm:right-6 sm:w-[420px] sm:max-w-[calc(100vw-2rem)] flex flex-col bg-surface sm:rounded-2xl border border-edge shadow-2xl sm:h-[600px] sm:max-h-[calc(100vh-3rem)]">
          {/* ヘッダ */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center">
                <Icon name="sparkles" className="w-4 h-4" />
              </span>
              <p className="text-sm font-bold text-ink">AIアシスタント</p>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  onClick={() => { setMessages([]); setError('') }}
                  className="px-2 py-1 text-xs text-ink-muted hover:bg-surface-alt rounded-lg"
                >
                  クリア
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                aria-label="閉じる"
                className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded-lg text-ink-faint hover:bg-surface-alt"
              >
                <Icon name="close" className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* 本文 */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center py-6">
                <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-brand-50 text-brand-600 flex items-center justify-center">
                  <Icon name="sparkles" className="w-6 h-6" />
                </div>
                <p className="text-sm text-ink-muted">使い方やデータのことを聞いてください。</p>
                <div className="mt-4 flex flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="text-left text-sm px-3 py-2 rounded-lg border border-edge text-ink-muted hover:bg-surface-alt hover:text-ink"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                    m.role === 'user'
                      ? 'bg-brand-600 text-white'
                      : 'bg-surface-alt text-ink'
                  }`}
                >
                  {m.role === 'user'
                    ? <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                    : <MarkdownLite text={m.content} />}
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div className="rounded-2xl px-3 py-2 bg-surface-alt text-ink-muted flex items-center gap-2">
                  <Spinner className="w-4 h-4" />
                  <span className="text-sm">考えています…</span>
                </div>
              </div>
            )}

            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
            )}
          </div>

          {/* 入力 */}
          <div className="border-t border-edge p-3">
            <form
              onSubmit={(e) => { e.preventDefault(); send(input) }}
              className="flex items-end gap-2"
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
                }}
                rows={1}
                placeholder="質問を入力(Enterで送信)"
                className="flex-1 resize-none max-h-32 px-3 py-2 text-sm border border-edge rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="min-h-[40px] px-3 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-40"
              >
                送信
              </button>
            </form>
            <p className="mt-1.5 text-[10px] text-ink-faint text-center">AIが生成した回答です。重要な操作は内容をご確認ください。</p>
          </div>
        </div>
      )}
    </>
  )
}
