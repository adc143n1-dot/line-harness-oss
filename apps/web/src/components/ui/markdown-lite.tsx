import { Fragment, type ReactNode } from 'react'
import Link from 'next/link'

// 依存なしの軽量Markdown表示。AIの回答(見出し/箇条書き/太字/内部リンク)を読みやすくする。
// React がテキストをエスケープするので XSS の心配はない(dangerouslySetInnerHTML 不使用)。
// 対応: 見出し(#/##/###)・箇条書き(- / *)・番号付き(1. )・太字(**...**)・
//       内部リンク [ラベル](/path) ※href が "/" で始まるものだけ許可・空行。

// **bold** と [label](/path) を混在で扱うため、両方にマッチする分割正規表現。
const INLINE_RE = /(\*\*[^*]+\*\*|\[[^\]]+\]\(\/[^)\s]*\))/g

function renderInline(text: string, keyBase: string, onNavigate?: () => void): ReactNode[] {
  const parts = text.split(INLINE_RE)
  return parts.map((p, i) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(p)
    if (bold) return <strong key={`${keyBase}-b${i}`} className="font-semibold text-ink">{bold[1]}</strong>
    // 内部リンクのみ許可 (href が "/" で始まる)。外部URLはリンク化しない。
    const link = /^\[([^\]]+)\]\((\/[^)\s]*)\)$/.exec(p)
    if (link) {
      return (
        <Link
          key={`${keyBase}-l${i}`}
          href={link[2]}
          onClick={() => onNavigate?.()}
          className="text-brand-700 underline underline-offset-2 hover:text-brand-800"
        >
          {link[1]}
        </Link>
      )
    }
    return <Fragment key={`${keyBase}-t${i}`}>{p}</Fragment>
  })
}

export default function MarkdownLite({ text, className = '', onNavigate }: { text: string; className?: string; onNavigate?: () => void }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let key = 0

  const flushList = () => {
    if (!list) return
    const items = list.items
    const ordered = list.ordered
    blocks.push(
      ordered ? (
        <ol key={`l${key++}`} className="list-decimal pl-5 my-1 space-y-0.5">
          {items.map((it, i) => <li key={i}>{renderInline(it, `li${key}-${i}`, onNavigate)}</li>)}
        </ol>
      ) : (
        <ul key={`l${key++}`} className="list-disc pl-5 my-1 space-y-0.5">
          {items.map((it, i) => <li key={i}>{renderInline(it, `li${key}-${i}`, onNavigate)}</li>)}
        </ul>
      ),
    )
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { flushList(); continue }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushList()
      blocks.push(
        <p key={`h${key++}`} className="font-bold text-ink mt-2 first:mt-0">
          {renderInline(heading[2], `h${key}`, onNavigate)}
        </p>,
      )
      continue
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] } }
      list.items.push(bullet[1])
      continue
    }

    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (numbered) {
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] } }
      list.items.push(numbered[1])
      continue
    }

    flushList()
    blocks.push(<p key={`p${key++}`} className="my-1">{renderInline(line, `p${key}`, onNavigate)}</p>)
  }
  flushList()

  return <div className={`text-sm leading-relaxed ${className}`}>{blocks}</div>
}
