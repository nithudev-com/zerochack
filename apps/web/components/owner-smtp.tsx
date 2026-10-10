'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, ErrorState, Input, LoadingState, Select } from '@zerochack/ui';
import { api } from '../lib/api';

type Settings = { host: string; port: number; user: string; from: string; fromName: string; passwordSet: boolean; source: 'owner' | 'server'; revision: string; testRecipient: string };
export function OwnerSmtp() {
  const query = useQuery<Settings>({ queryKey: ['owner-smtp'], queryFn: () => api('/owner/smtp'), retry: false });
  if (query.isLoading) return <LoadingState label="Loading SMTP settings" />;
  if (query.isError || !query.data) return <><ErrorState description={query.error?.message ?? 'Unable to load SMTP settings'} retry={() => void query.refetch()} /><p>Owner access and recent MFA are required. <Link href="/owner/login">Sign in again</Link></p></>;
  return <SmtpForm key={query.data.revision} settings={query.data} reload={() => query.refetch()} />;
}

function SmtpForm({ settings, reload }: { settings: Settings; reload: () => Promise<unknown> }) {
  const [form, setForm] = useState({ host: settings.host, port: String(settings.port), user: settings.user, from: settings.from, fromName: settings.fromName });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const update = (key: keyof typeof form, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  const changed = Object.entries(form).some(([key, value]) => String(settings[key as keyof Settings]) !== value) || Boolean(password);
  const requiresPassword = !settings.passwordSet || form.host !== settings.host || form.user !== settings.user;
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await api('/owner/smtp', { method: 'PUT', body: JSON.stringify({ ...form, port: Number(form.port), revision: settings.revision, ...(password ? { password } : {}) }) });
      setPassword(''); await reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'SMTP settings could not be saved.'); }
    finally { setPassword(''); setBusy(false); }
  }
  async function check(send: boolean) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ message: string }>(`/owner/smtp/${send ? 'test' : 'verify'}`, { method: 'POST', ...(send ? { body: JSON.stringify({ confirm: true }) } : {}) });
      setNotice(result.message); if (send) setConfirmed(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'SMTP check failed.'); }
    finally { setBusy(false); }
  }
  return <div className="portal-stack owner-console-page">
    <header className="portal-heading"><div><span className="eyebrow">Owner control center</span><h1>SMTP Settings</h1><p>One mail connection for account verification, password resets, invitations, and background notification emails across CodeBandage.</p></div></header>
    <Alert title={settings.source === 'owner' ? 'Saved Owner SMTP settings are active' : 'Server SMTP defaults are active'}>Changes apply to new email attempts immediately. Passwords are encrypted and never returned to this page. In-flight emails may finish using the previous settings.</Alert>
    {error && <Alert title="Unable to continue" tone="danger">{error} <Link href="/owner/login">Sign in again if MFA has expired</Link>.</Alert>}
    {notice && <Alert title="SMTP check complete" tone="success">{notice}</Alert>}
    <Card><form onSubmit={save} className="portal-stack" aria-label="Application SMTP settings">
      <h2>Mail server and sender</h2>
      <Input id="smtp-host" label="SMTP host" value={form.host} required maxLength={253} autoComplete="off" onChange={event => update('host', event.target.value)} />
      <Select id="smtp-port" label="Connection security" value={form.port} onChange={event => update('port', event.target.value)}>
        {![465, 587].includes(settings.port) && <option value={String(settings.port)} disabled>Select a secure port</option>}
        <option value="465">Port 465 — implicit TLS/SSL</option><option value="587">Port 587 — required STARTTLS</option>
      </Select>
      <Input id="smtp-user" label="SMTP username" value={form.user} required maxLength={320} autoComplete="off" onChange={event => update('user', event.target.value)} />
      <Input id="smtp-password" label="SMTP password" type="password" value={password} required={requiresPassword} maxLength={1024} autoComplete="new-password" placeholder={settings.passwordSet ? 'Saved securely — leave blank to keep' : 'Enter SMTP password'} onChange={event => setPassword(event.target.value)} />
      <p className="form-hint">Changing the host or username requires a new password. Use your mail-provider password or app password, not your CodeBandage login password.</p>
      <Input id="smtp-from" label="Sender email address" type="email" value={form.from} required maxLength={320} onChange={event => update('from', event.target.value)} />
      <Input id="smtp-name" label="Sender display name" value={form.fromName} required maxLength={120} onChange={event => update('fromName', event.target.value)} />
      <p>Hostinger: smtp.hostinger.com, port 465. The sender must be permitted by your provider. IMAP and POP settings are not needed for outgoing application email.</p>
      <Button type="submit" disabled={busy || !changed}>Verify and save SMTP</Button>
      <p className="form-hint">TLS and authentication must pass before changes replace the working settings. This does not prove sender authorization or inbox delivery.</p>
    </form></Card>
    <Card className="portal-stack"><h2>Check saved settings</h2>
      <p>{changed ? 'Save your changes first. These checks use the currently active settings.' : 'Connection verification sends no email.'}</p>
      <Button type="button" variant="secondary" disabled={busy || changed} onClick={() => void check(false)}>Verify saved connection</Button>
      <label className="ui-field"><span><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> Send one test email to my verified Owner mailbox: {settings.testRecipient}</span></label>
      <Button type="button" variant="secondary" disabled={busy || changed || !confirmed} onClick={() => void check(true)}>Send test email to me</Button>
      <p className="form-hint">Maximum three test emails per hour. Check inbox and spam manually. Existing verification, approval, opt-out, and email-automation policies remain in force.</p>
    </Card>
    <p><Link href="/owner/email-automation">Manage email templates and automation →</Link></p>
  </div>;
}
