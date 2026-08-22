import type { IconName } from '@/components/ui/icons'

// サイドバーのメニュー定義 (表示ロジックとデータを分離)
export interface NavItem {
  href: string
  label: string
  icon: IconName
  danger?: boolean
}

export interface NavSection {
  /** null = セクションラベルなし (メイン、常時表示) */
  label: string | null
  items: NavItem[]
}

export const menuSections: NavSection[] = [
  {
    label: null,
    items: [
      { href: '/', label: 'ダッシュボード', icon: 'home' },
      { href: '/guide', label: '運用ガイド', icon: 'book' },
      { href: '/friends', label: '友だち管理', icon: 'users' },
      { href: '/tags', label: 'タグ管理', icon: 'tag' },
      { href: '/chats', label: '個別チャット', icon: 'chat' },
      { href: '/board', label: 'チャットボード', icon: 'clipboard' },
      { href: '/team', label: 'チーム状況', icon: 'users' },
    ],
  },
  {
    label: '配信',
    items: [
      { href: '/friend-add-settings', label: '友だち追加時設定', icon: 'plus' },
      { href: '/scenarios', label: 'シナリオ配信', icon: 'clipboard-list' },
      { href: '/broadcasts', label: '一斉配信', icon: 'megaphone' },
      { href: '/templates', label: 'テンプレート', icon: 'template' },
      { href: '/rich-menus', label: 'リッチメニュー', icon: 'grid' },
      { href: '/reminders', label: 'リマインダ', icon: 'clock' },
      { href: '/webinars', label: 'ウェビナー', icon: 'video' },
    ],
  },
  {
    label: '分析',
    items: [
      { href: '/inflow-links', label: 'リファラルリンク', icon: 'link' },
      { href: '/job-matching-leads', label: '副業マッチングリード', icon: 'star' },
      { href: '/affiliates', label: 'アフィリエイト', icon: 'share' },
      { href: '/conversions', label: 'CV計測', icon: 'chart-bar' },
      { href: '/scoring', label: 'マイル', icon: 'star' },
      { href: '/form-submissions', label: 'フォーム回答', icon: 'document' },
      { href: '/duplicates', label: '重複検出', icon: 'copy' },
    ],
  },
  {
    label: '自動化',
    items: [
      { href: '/automations', label: 'オートメーション', icon: 'bolt' },
      { href: '/auto-replies', label: '自動返信ルール', icon: 'reply' },
      { href: '/webhooks', label: 'Webhook', icon: 'terminal' },
      { href: '/notifications', label: '未対応', icon: 'bell' },
    ],
  },
  {
    label: '予約',
    items: [
      { href: '/booking/bookings', label: '予約管理', icon: 'calendar' },
      { href: '/booking/menus', label: 'メニュー', icon: 'menu' },
      { href: '/booking/staff', label: 'スタッフ', icon: 'users' },
      { href: '/events', label: 'イベント予約', icon: 'calendar-event' },
    ],
  },
  {
    label: '設定',
    items: [
      { href: '/staff', label: 'スタッフ管理', icon: 'user-group' },
      { href: '/security', label: 'アクセス制限', icon: 'lock' },
      { href: '/accounts', label: 'LINEアカウント', icon: 'building' },
      { href: '/telegram-accounts', label: 'Telegramアカウント', icon: 'chat' },
      { href: '/pools', label: 'プール管理', icon: 'rows' },
      { href: '/measurements', label: '計測データ', icon: 'chart-bar' },
      { href: '/users', label: 'ユーザー一覧', icon: 'identity' },
      { href: '/health', label: 'BAN検知', icon: 'shield' },
      { href: '/updates', label: 'アップデート履歴', icon: 'refresh' },
      { href: '/emergency', label: '緊急コントロール', icon: 'warning', danger: true },
    ],
  },
]
