'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { CloseIcon, EyeIcon, EyeOffIcon, QrCodeIcon, WeChatIcon } from './icons'

/**
 * The Dynadot login / register modal. On the source this is a `dyna-overlay`
 * opened by the header Login button — there is no standalone route.
 * Measured (1440px):
 *   overlay  fixed inset-0, background rgba(33,38,32,.2), z-index 2001 (above
 *            the navbar's 2000), click-to-dismiss
 *   card     666 wide, radius 10px, white, shadow 0 4px 20px rgba(33,38,32,.15);
 *            login 539 tall, register 720 tall
 *   header   padding 20px top; heading 16px/400 #212620
 *   tabs     "Username & Password" (active 14px/600 #031242) / "QR Code"
 *   Sign In  395x44, #031242, radius 60px, white 16px
 *   socials  192x36, white, 1px #D3DBE2, radius 6px
 *   register First/Last 190px side by side, Email/Username/Password/Referral
 *            full width, two checkboxes, Continue
 */

type Mode = 'login' | 'register'
type LoginTab = 'code' | 'password' | 'qr'

function Field({
  label,
  type = 'text',
  forgot,
}: {
  label: string
  type?: string
  forgot?: string
}) {
  const [show, setShow] = useState(false)
  const isPassword = type === 'password'

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-[#131E42]">{label}</label>
        {forgot ? (
          <button
            type="button"
            className="text-sm text-[#0072BC] transition-colors hover:text-[#006EF5]"
          >
            {forgot}
          </button>
        ) : null}
      </div>
      <div className="relative">
        <input
          type={isPassword && show ? 'text' : type}
          className="h-11 w-full rounded-[6px] border border-[#D3DBE2] bg-white px-3.5 text-[15px] text-[#131E42] outline-none transition-colors focus:border-[#0072BC]"
        />
        {isPassword ? (
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? 'Hide password' : 'Show password'}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#7A8194] transition-colors hover:text-[#131E42]"
          >
            {show ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Third-party auth. This clone only integrates WeChat — Google/Apple are
 * removed. `prefix` is "Continue With " on register, "" on login.
 */
function SocialButtons({ prefix }: { prefix: string }) {
  return (
    <button
      type="button"
      className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-[6px] border border-[#D3DBE2] bg-white text-[15px] text-[#001345] transition-colors hover:bg-[#F6F9FF]"
    >
      <WeChatIcon className="h-5 w-5" />
      {prefix}WeChat
    </button>
  )
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex w-full items-center gap-3 py-1 text-sm text-[#7A8194]">
      <span className="h-px flex-1 bg-[#E4E7ED]" />
      {label}
      <span className="h-px flex-1 bg-[#E4E7ED]" />
    </div>
  )
}

export function AccountModal({
  open,
  onClose,
  initialMode = 'login',
}: {
  open: boolean
  onClose: () => void
  initialMode?: Mode
}) {
  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // Unmounting on close means this always mounts fresh at `initialMode`,
  // so entry state needs no effect-driven reset.
  return <ModalBody onClose={onClose} initialMode={initialMode} />
}

function ModalBody({ onClose, initialMode }: { onClose: () => void; initialMode: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [tab, setTab] = useState<LoginTab>('code')
  const [agree, setAgree] = useState(false)

  return (
    <div
      className="fixed inset-0 z-[2001] flex items-start justify-center overflow-y-auto bg-[rgba(33,38,32,0.2)] px-4 py-[150px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'login' ? 'Sign in' : 'Create an account'}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[666px] rounded-[10px] bg-white shadow-[0_4px_20px_0_rgba(33,38,32,0.15)]"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-5 top-5 text-[18px] text-[#7A8194] transition-colors hover:text-[#131E42]"
        >
          <CloseIcon className="h-[18px] w-[18px]" />
        </button>

        {/* Card is 666 wide, but the content is a ~406px column centred inside
            it (fields measure 395–406 on the source, not full width). Constrain
            the column here rather than letting fields stretch edge-to-edge. */}
        <div className="flex flex-col items-center px-[34px] pb-9 pt-7">
          <div className="mx-auto w-full max-w-[406px]">
            {mode === 'login' ? (
              <LoginPanel tab={tab} setTab={setTab} onRegister={() => setMode('register')} />
            ) : (
              <RegisterPanel agree={agree} setAgree={setAgree} onSignIn={() => setMode('login')} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function LoginPanel({
  tab,
  setTab,
  onRegister,
}: {
  tab: LoginTab
  setTab: (t: LoginTab) => void
  onRegister: () => void
}) {
  return (
    <div className="flex w-full flex-col items-center gap-5">
      <div className="flex flex-col items-center gap-1.5 pt-1 text-center">
        <h2 className="text-lg font-semibold text-[#212620]">Sign in to your account</h2>
        <p className="text-sm text-[#7A8194]">
          Not a member yet?{' '}
          <button
            type="button"
            onClick={onRegister}
            className="font-medium text-[#0072BC] transition-colors hover:text-[#006EF5]"
          >
            Create an account
          </button>
        </p>
      </div>

      {/* Tab row. Verification-code login is the default method; username &
          password and QR are secondary. */}
      <div className="flex w-full gap-5 border-b border-[#E4E7ED]">
        {(
          [
            ['code', 'Verification Code'],
            ['password', 'Password'],
            ['qr', 'WeChat'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'relative -mb-px whitespace-nowrap pb-2.5 text-sm transition-colors',
              tab === key
                ? 'font-semibold text-[#031242] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#031242]'
                : 'font-medium text-[#7A8194] hover:text-[#031242]',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'code' ? (
        <div className="flex w-full flex-col gap-5 pt-1">
          {/* Single field accepts a phone number or an email; Send Code then
              delivers the matching SMS / email code. */}
          <Field label="Phone or Email" />
          <VerificationField sendLabel="Send Code" />
          <button
            type="button"
            className="h-11 w-full rounded-[60px] bg-[#031242] text-base text-white transition-colors hover:bg-[#0A3D9A]"
          >
            Sign In
          </button>
        </div>
      ) : tab === 'password' ? (
        <div className="flex w-full flex-col gap-5 pt-1">
          {/* Forgot Username intentionally omitted per product decision; the
              source has it, but this clone keeps only Forgot Password. */}
          <Field label="Username" />
          <Field label="Password" type="password" forgot="Forgot Password?" />
          <button
            type="button"
            className="h-11 w-full rounded-[60px] bg-[#031242] text-base text-white transition-colors hover:bg-[#0A3D9A]"
          >
            Sign In
          </button>
        </div>
      ) : (
        <div className="flex w-full flex-col items-center gap-4 py-4">
          <div className="relative flex size-[180px] items-center justify-center rounded-[10px] border border-[#D3DBE2] text-[#7A8194]">
            <QrCodeIcon className="h-24 w-24" />
            <span className="absolute bottom-2.5 right-2.5 flex size-7 items-center justify-center rounded-full bg-white">
              <WeChatIcon className="h-5 w-5" />
            </span>
          </div>
          <p className="max-w-[280px] text-center text-sm text-[#7A8194]">
            Open WeChat, tap Scan, and scan this QR code to sign in.
          </p>
        </div>
      )}
    </div>
  )
}

/** Verification-code row: an input plus a Send Code button (label varies). */
function VerificationField({ sendLabel }: { sendLabel: string }) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <label className="text-sm font-medium text-[#131E42]">Verification Code</label>
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          className="h-11 min-w-0 flex-1 rounded-[6px] border border-[#D3DBE2] bg-white px-3.5 text-[15px] text-[#131E42] outline-none transition-colors focus:border-[#0072BC]"
        />
        <button
          type="button"
          className="h-11 shrink-0 whitespace-nowrap rounded-[6px] border border-[#031242] px-4 text-sm font-medium text-[#031242] transition-colors hover:bg-[#031242] hover:text-white"
        >
          {sendLabel}
        </button>
      </div>
    </div>
  )
}

/**
 * Simplified register — this clone does not fully replicate the source form.
 * A single "Phone or Email" field accepts either; Send Code delivers the
 * matching SMS / email code. Username + password, no first/last name, no
 * referral. WeChat scan sign-up is kept as the third-party option.
 */
function RegisterPanel({
  agree,
  setAgree,
  onSignIn,
}: {
  agree: boolean
  setAgree: (v: boolean) => void
  onSignIn: () => void
}) {
  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex flex-col items-center gap-1 text-center">
        <h2 className="text-lg font-semibold text-[#212620]">Create a Dynadot account</h2>
        <p className="text-sm text-[#7A8194]">
          Already a member?{' '}
          <button
            type="button"
            onClick={onSignIn}
            className="font-medium text-[#0072BC] transition-colors hover:text-[#006EF5]"
          >
            Sign in
          </button>
        </p>
      </div>

      {/* WeChat scan sign-up kept as the only third-party option */}
      <SocialButtons prefix="Sign up with " />
      <Divider label="Or Sign up with" />

      <Field label="Username" />
      <Field label="Phone or Email" />
      <VerificationField sendLabel="Send Code" />
      <Field label="Password" type="password" />

      <div className="flex w-full pt-1">
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-[#4B5162]">
          <input
            type="checkbox"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
            className="mt-0.5 size-4 accent-[#031242]"
          />
          I have read and agree to abide by the{' '}
          <span className="text-[#0072BC]">Dynadot Service Agreement</span>.
        </label>
      </div>

      <button
        type="button"
        disabled={!agree}
        className="h-11 w-full rounded-[60px] bg-[#031242] text-base text-white transition-colors hover:bg-[#0A3D9A] disabled:cursor-not-allowed disabled:opacity-50"
      >
        Continue
      </button>
    </div>
  )
}
