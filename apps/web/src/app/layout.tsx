import type { Metadata } from 'next'
import { Noto_Sans_JP } from 'next/font/google'
import './globals.css'
import AppShell from '@/components/app-shell'

// 日本語フォントはビルド時にセルフホスト化される (実行時の外部依存なし)
const notoSansJP = Noto_Sans_JP({
  weight: ['400', '500', '700'],
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  variable: '--font-noto',
})

export const metadata: Metadata = {
  title: 'L Harness',
  description: 'L Harness 管理画面',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja" className={notoSansJP.variable}>
      <body className="bg-app text-ink antialiased font-sans">
        <AppShell>
          {children}
        </AppShell>
      </body>
    </html>
  )
}
