import { Fragment, type ReactNode } from 'react'

// 依存なしの軽量Markdown表示。AIの回答(見出し/箇条書き/太字)を読みやすくする。
// React がテキストをエスケープするので XSS の心配はない(dangerouslySetInnerHTML 不使用)。
// 対応: 見出し(#/##/###)・箇条書き(- / *)・番号付き(1. )・太字(**...**)・空行。

function renderInline(text: string, keyBase: string): ReactNode[] {
  // **bold** を <strong> に。ペアが揃わない ** はそのまま表示。
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(p)
    if (m) return <strong key={`${keyBase}-b${i}`} className="font-semibold text-ink">{m[1]}</strong>
    return <Fragment key={`${keyBase}-t${i}`}>{p}</Fragment>
  })
}

export default function MarkdownLite({ text, className = '' }: { text: string; className?: string }) {
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
          {items.map((it, i) => <li key={i}>{renderInline(it, `li${key}-${i}`)}</li>)}
        </ol>
      ) : (
        <ul key={`l${key++}`} className="list-disc pl-5 my-1 space-y-0.5">
          {items.map((it, i) => <li key={i}>{renderInline(it, `li${key}-${i}`)}</li>)}
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
          {renderInline(heading[2], `h${key}`)}
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
    blocks.push(<p key={`p${key++}`} className="my-1">{renderInline(line, `p${key}`)}</p>)
  }
  flushList()

  return <div className={`text-sm leading-relaxed ${className}`}>{blocks}</div>
}
