'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { Button, Input, Alert } from '@zerochack/ui';

type Role = 'Customer' | 'Agency' | 'Affiliate' | 'Cybersecurity Specialist' | 'Owner';
type FormValues = { displayName: string; organizationName: string; email: string; password: string };
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export function AuthForm({ mode, role, portal }: { mode: 'login' | 'register'; role: Role; portal: string }) {
  const router = useRouter(); const [serverError, setServerError] = useState<string>();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormValues>();
  const submit = handleSubmit(async (values) => {
    setServerError(undefined); const endpoint = mode === 'register' ? '/auth/register' : `/auth/${portal}/login`;
    if (mode === 'register' && (role === 'Cybersecurity Specialist' || role === 'Owner')) { setServerError('This staff role can only be provisioned by a platform owner.'); return; }
    const payload = mode === 'register' ? { ...values, role } : { email: values.email, password: values.password };
    try {
      const response = await fetch(`${apiUrl}${endpoint}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); const body = await response.json();
      if (!response.ok) {
        const code = body?.error?.code as string | undefined; const stateRoutes: Record<string, string> = { APPROVAL_PENDING: '/approval-pending', ACCOUNT_REJECTED: '/rejected', ACCOUNT_SUSPENDED: '/suspended', ACCOUNT_DEACTIVATED: '/deactivated' };
        if (code && stateRoutes[code]) { router.push(stateRoutes[code]); return; }
        setServerError(body?.error?.message ?? 'The request could not be completed.'); return;
      }
      if (mode === 'register') { router.push('/verify-email?sent=1'); return; }
      if (body.mfaRequired) { sessionStorage.setItem('zerochack_mfa_challenge', body.challengeToken); router.push(body.enrollmentRequired ? '/mfa?enroll=1' : body.enrollmentPending ? '/mfa?confirm=1' : '/mfa'); return; }
      router.push(role === 'Customer' ? '/customer/overview' : role === 'Agency' ? '/agency/overview' : role === 'Affiliate' ? '/affiliate/overview' : role === 'Cybersecurity Specialist' ? '/specialist/overview' : '/account');
    } catch { setServerError('Unable to reach ZeroRoot. Check your connection and try again.'); }
  });
  return <form className="auth-form" onSubmit={submit} noValidate>
    {serverError && <Alert title="Unable to continue" tone="danger">{serverError}</Alert>}
    {mode === 'register' && <><Input label="Full name" autoComplete="name" error={errors.displayName?.message} {...register('displayName', { required: 'Name is required', minLength: { value: 2, message: 'Enter at least 2 characters' } })} /><Input label="Organization name" autoComplete="organization" error={errors.organizationName?.message} {...register('organizationName', { required: 'Organization is required', minLength: { value: 2, message: 'Enter at least 2 characters' } })} /></>}
    <Input label="Email address" type="email" autoComplete="email" error={errors.email?.message} {...register('email', { required: 'Email is required' })} />
    <Input label="Password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} error={errors.password?.message} {...register('password', { required: 'Password is required', ...(mode === 'register' ? { minLength: { value: 12, message: 'Use at least 12 characters' } } : {}) })} />
    {mode === 'register' && <p className="form-hint">Use 12–128 characters with uppercase, lowercase, number, and symbol.</p>}
    <Button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Please wait…' : mode === 'login' ? `Sign in as ${role}` : `Create ${role} account`}</Button>
    {mode === 'login' && <div className="auth-links"><Link className="text-link" href="/forgot-password">Forgot password?</Link><Link className="text-link" href="/sign-in">Choose another portal</Link></div>}
    {mode === 'register' && <p className="auth-switch">Already registered? <Link href={`/${portal}/login`}>Sign in</Link></p>}
  </form>;
}

export function AuthPage({ mode, role, portal }: { mode: 'login' | 'register'; role: Role; portal: string }) {
  return <div className={`auth-layout auth-layout--${portal}`}><section className="auth-copy"><span className="eyebrow">{role} portal</span><h1>{mode === 'login' ? 'Welcome back.' : 'Create your secure account.'}</h1><p>{mode === 'register' && role !== 'Customer' ? 'After email verification, an Owner must approve this account before access is enabled.' : 'Authentication, role, account status, and tenant access are verified by the ZeroRoot API.'}</p><div className="auth-art" aria-hidden="true"><i/><i/><i/><span>{role[0]}</span></div></section><div className="auth-panel"><div className="auth-panel__head"><span>{mode === 'login' ? 'SECURE SIGN IN' : 'ACCOUNT SETUP'}</span><p>{mode === 'login' ? 'Enter your account credentials to continue.' : 'Start your protected ZeroRoot workspace.'}</p></div><AuthForm mode={mode} role={role} portal={portal} /></div></div>;
}
