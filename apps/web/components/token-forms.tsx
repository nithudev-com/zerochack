'use client';
import { useSearchParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import QRCode from 'qrcode';
import { Alert, Button, Input, LoadingState } from '@zerochack/ui';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';
async function post(path: string, payload: unknown) { const response = await fetch(`${apiUrl}${path}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); const body = response.status === 204 ? {} : await response.json(); if (!response.ok) throw new Error(body?.error?.message ?? 'Request failed'); return body; }

export function VerifyEmailForm() {
  const params = useSearchParams(); const token = params.get('token'); const sent = params.get('sent'); const [state, setState] = useState<'idle' | 'loading' | 'verified' | 'pending' | 'error'>(sent ? 'idle' : token ? 'loading' : 'error'); const [message, setMessage] = useState(token || sent ? '' : 'Verification token is missing.');
  useEffect(() => { if (!token) return; void post('/auth/verify-email', { token }).then((body) => setState(body.status === 'PENDING_APPROVAL' ? 'pending' : 'verified')).catch((error: unknown) => { setMessage(error instanceof Error ? error.message : 'Verification failed'); setState('error'); }); }, [token]);
  if (state === 'loading') return <LoadingState label="Verifying your email" />;
  if (state === 'verified') return <Alert title="Email verified" tone="success">Your account is active. You can now sign in.</Alert>;
  if (state === 'pending') return <Alert title="Email verified" tone="success">Your account is now pending Owner approval.</Alert>;
  if (state === 'error') return <Alert title="Verification failed" tone="danger">{message}</Alert>;
  return <Alert title="Check your email" tone="info">We sent a single-use verification link. It expires automatically.</Alert>;
}

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false); const [error, setError] = useState<string>(); const { register, handleSubmit, formState: { isSubmitting } } = useForm<{ email: string }>();
  if (sent) return <Alert title="Check your email" tone="success">If the address is eligible, a single-use reset link has been sent.</Alert>;
  return <form className="auth-form" onSubmit={handleSubmit(async (data) => { setError(undefined); try { await post('/auth/forgot-password', data); setSent(true); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Request failed'); } })}>{error && <Alert title="Unable to continue" tone="danger">{error}</Alert>}<Input label="Email address" type="email" autoComplete="email" {...register('email', { required: true })} /><Button disabled={isSubmitting}>Send reset link</Button></form>;
}

export function ResetPasswordForm() {
  const router = useRouter(); const token = useSearchParams().get('token') ?? ''; const [error, setError] = useState<string>(); const { register, handleSubmit, formState: { isSubmitting } } = useForm<{ password: string }>();
  return <form className="auth-form" onSubmit={handleSubmit(async ({ password }) => { setError(undefined); try { await post('/auth/reset-password', { token, password }); router.push('/'); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Reset failed'); } })}>{error && <Alert title="Reset failed" tone="danger">{error}</Alert>}<Input label="New password" type="password" autoComplete="new-password" {...register('password', { required: true, minLength: 12 })} /><p className="form-hint">Use uppercase, lowercase, number, and symbol.</p><Button disabled={isSubmitting}>Reset password</Button></form>;
}

export function MfaForm() {
  const router = useRouter(); const params = useSearchParams(); const enroll = params.get('enroll') === '1'; const confirmEnrollment = params.get('confirm') === '1'; const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string }>(); const [qrCode, setQrCode] = useState<string>(); const [error, setError] = useState<string>(); const [recovery, setRecovery] = useState<string[]>(); const enrollmentRequested = useRef(false); const { register, handleSubmit, watch, formState: { isSubmitting } } = useForm<{ code: string }>(); const codeValue = watch('code', ''); const numericProgress = /^\d{0,6}$/u.test(codeValue) ? codeValue.length : 0;
  const challengeToken = typeof window === 'undefined' ? '' : sessionStorage.getItem('zerochack_mfa_challenge') ?? '';
  useEffect(() => { if (!enroll || !challengeToken || enrollmentRequested.current) return; enrollmentRequested.current = true; void post('/auth/mfa/enroll', { token: challengeToken }).then((body) => setEnrollment({ secret: body.secret, otpauthUri: body.otpauthUri })).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Enrollment failed')); }, [challengeToken, enroll]);
  useEffect(() => { if (!enrollment?.otpauthUri) return; void QRCode.toDataURL(enrollment.otpauthUri, { errorCorrectionLevel: 'M', margin: 2, width: 240, color: { dark: '#07120f', light: '#ffffff' } }).then(setQrCode).catch(() => setError('Unable to generate the authenticator QR code. Use the manual setup key instead.')); }, [enrollment]);
  if (recovery) return <div className="auth-form"><Alert title="Save recovery codes" tone="warning">Each code works once. Store them offline now; they will not be shown again.</Alert><pre className="recovery-codes">{recovery.join('\n')}</pre><Button onClick={() => router.push('/owner/overview')}>Continue</Button></div>;
  const confirming = enroll || confirmEnrollment;
  return <form className="auth-form mfa-verify-form" onSubmit={handleSubmit(async ({ code }) => { setError(undefined); try { const body = await post(confirming ? '/auth/mfa/confirm' : '/auth/mfa/verify', { challengeToken, code }); sessionStorage.removeItem('zerochack_mfa_challenge'); if (body.recoveryCodes) setRecovery(body.recoveryCodes); else router.push('/owner/overview'); } catch (caught) { setError(caught instanceof Error ? caught.message : 'MFA failed'); } })}>{error && <Alert title="Verification failed" tone="danger">{error}</Alert>}{confirmEnrollment && <Alert title="Authenticator ready" tone="info">Enter the current code from the authenticator you already added. You do not need to add it again.</Alert>}{enroll && enrollment && <section className="mfa-enrollment" aria-labelledby="mfa-setup-title"><div><span className="eyebrow">Authenticator setup</span><h2 id="mfa-setup-title">Scan this QR code</h2><p>Open Google Authenticator, Microsoft Authenticator, Authy, or another TOTP app and scan the code.</p></div>{qrCode ? <Image className="mfa-qr-code" src={qrCode} width={240} height={240} unoptimized alt="QR code for adding ZeroRoot to your authenticator app" /> : <LoadingState label="Generating QR code" />}<details className="mfa-manual-key"><summary>Can’t scan? Use the setup key</summary><code>{enrollment.secret}</code></details></section>}<div className="mfa-code-meter" aria-hidden="true">{Array.from({length:6},(_,index)=><i className={index<numericProgress?'is-filled':''} key={index}>{index<numericProgress?'•':''}</i>)}</div><Input label={confirming ? 'Six-digit code' : 'Authenticator or recovery code'} inputMode="numeric" autoComplete="one-time-code" maxLength={confirming ? 6 : 32} {...register('code', { required: true })} /><div className="mfa-form-hint"><span>{numericProgress===6?'Code ready to verify':numericProgress>0?`${6-numericProgress} digits remaining`:'Codes refresh every 30 seconds'}</span><span>{numericProgress}/6</span></div><Button disabled={isSubmitting || (enroll && !enrollment)}>{isSubmitting?'Verifying securely…':'Verify and unlock'}</Button>{confirmEnrollment && <Link className="text-link" href="/mfa?enroll=1">Show my setup QR code again</Link>}</form>;
}
