'use client'
import { usePathname } from 'next/navigation'
import Sidebar from './layout/sidebar'
import { UpdateBanner } from './update/update-banner'
import AuthGuard from './auth-guard'
import { AccountProvider } from '@/contexts/account-context'
import { ConfirmProvider } from '@/components/ui/confirm-dialog'
import AssistantPanel from '@/components/assistant/assistant-panel'

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (pathname === '/login') {
    return <ConfirmProvider>{children}</ConfirmProvider>
  }

  return (
    <AuthGuard>
      <AccountProvider>
        <ConfirmProvider>
          <div className="flex min-h-screen flex-col">
          {/* Phase 6: banner above sidebar+header so it pins to the top of the
              admin shell. Renders nothing while loading; one of latest/fork/
              upgrade once /admin/version + manifest resolve. */}
          <UpdateBanner />
          <div className="flex flex-1 min-h-0">
            <Sidebar />
            <main className="flex-1 overflow-auto pt-[72px] lg:pt-0">
              <div className="px-4 pb-6 sm:px-6 lg:pt-8 lg:px-8 lg:pb-8">
                {children}
              </div>
            </main>
            </div>
          </div>
          <AssistantPanel />
        </ConfirmProvider>
      </AccountProvider>
    </AuthGuard>
  )
}
