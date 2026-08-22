'use client'

import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Modal from './modal'
import Button from './button'

interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** danger は削除など取り返しのつかない操作用 (赤ボタン) */
  tone?: 'default' | 'danger'
}

interface AlertOptions {
  title: string
  message?: string
  okLabel?: string
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  alert: (options: AlertOptions) => Promise<void>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

type DialogState =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'alert'; options: AlertOptions; resolve: () => void }
  | null

// ネイティブ confirm()/alert() の置換先。
// AppShell 直下に <ConfirmProvider> をマウントし、各ページは useConfirm() で呼ぶ。
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState>(null)
  const dialogRef = useRef<DialogState>(null)
  dialogRef.current = dialog

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setDialog({ kind: 'confirm', options, resolve })
    })
  }, [])

  const alert = useCallback((options: AlertOptions) => {
    return new Promise<void>((resolve) => {
      setDialog({ kind: 'alert', options, resolve })
    })
  }, [])

  const close = useCallback((ok: boolean) => {
    const current = dialogRef.current
    if (!current) return
    setDialog(null)
    if (current.kind === 'confirm') current.resolve(ok)
    else current.resolve()
  }, [])

  return (
    <ConfirmContext.Provider value={{ confirm, alert }}>
      {children}
      {dialog && (
        <Modal
          open
          onClose={() => close(false)}
          title={dialog.options.title}
          maxWidth="max-w-sm"
          footer={
            dialog.kind === 'confirm' ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => close(false)}>
                  {dialog.options.cancelLabel ?? 'キャンセル'}
                </Button>
                <Button
                  variant={dialog.options.tone === 'danger' ? 'danger' : 'primary'}
                  size="sm"
                  onClick={() => close(true)}
                  autoFocus
                >
                  {dialog.options.confirmLabel ?? 'OK'}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => close(true)} autoFocus>
                {dialog.options.okLabel ?? 'OK'}
              </Button>
            )
          }
        >
          {dialog.options.message && (
            <p className="text-sm text-ink-muted whitespace-pre-wrap">{dialog.options.message}</p>
          )}
        </Modal>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>')
  return ctx
}
