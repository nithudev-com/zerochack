'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiClientError } from '../lib/api';
import { BrandLogo } from './brand-logo';
import { SecurityAgentActivity } from './security-agent-activity';
import { securityActivity, type AssessmentActivity } from '../lib/security-activity';
import styles from './security-chat.module.css';

type Website = { id: string; name: string; url: string };
type Message = { id: string; type: string; content: string; createdAt: string; author?: { displayName: string | null } | null };
type Access = { status: string; secretStored: boolean; lastCheckedAt: string | null; lastErrorCode: string | null; authorizationExpiresAt?: string | null };
type Care = { capabilities: { secureCapture?: boolean }; jobs: unknown[]; accessRequests: Array<{ status: string }> };
// Keep credential-like text out of MESSAGE requests, including authenticated URLs.
const sensitive = (text: string) => /-----BEGIN .*PRIVATE KEY-----|\b(?:password|passwd|pwd|secret|token|api[_ -]?key|private[_ -]?key)\s*[:=]\s*\S+|\bBearer\s+\S+|\bsk-[\w-]{12,}|\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]{1,1024}:[^\s/@]{1,4096}@/iu.test(text);

export function SecurityChat({ website }: { website: Website }) {
  const base = `/websites/${website.id}`; const client = useQueryClient();
  const [draft, setDraft] = useState(''); const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState(false); const [pendingMessage, setPendingMessage] = useState('');
  const [error, setError] = useState(''); const [connectionOpen, setConnectionOpen] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [cancelling, setCancelling] = useState(false); const cancellingRequest = useRef(false);
  const sending = useRef(false); const controller = useRef<AbortController | null>(null);
  const alive = useRef(true); const bottom = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null);
  const followLatest = useRef(true);
  const previousScan = useRef<string | null>(null); const cancelRequested = useRef(false);
  const access = useQuery({ queryKey: ['website-access', website.id], queryFn: () => api<Access | null>(`${base}/access`), retry: false, refetchInterval: 10000 });
  const care = useQuery({ queryKey: ['security-capture', website.id], queryFn: () => api<Care>(`${base}/care?environment=PRODUCTION`), retry: false, refetchInterval: 10000 });
  const chat = useInfiniteQuery({ queryKey: ['chat', website.id, 'PRODUCTION'], queryFn: ({ pageParam }) => api<Message[]>(`${base}/chat?environment=PRODUCTION${pageParam ? `&before=${pageParam}` : ''}`), initialPageParam: null as string | null, getNextPageParam: page => page.length === 200 ? page[0]!.id : undefined, refetchInterval: 5000, retry: false });
  const assessment = useQuery({ queryKey: ['security-assessment', website.id], queryFn: async () => { const result = await api<AssessmentActivity>(`${base}/assessment`); if (!result || !Object.hasOwn(result, 'scan')) throw new Error('Inspection activity is unavailable.'); return result; }, retry: false, refetchInterval: query => inspecting || query.state.data?.scan?.status === 'RUNNING' ? 1500 : 10000 });
  const activity = securityActivity(assessment.data, assessment.isError, busy, inspecting, previousScan.current);
  const messages = [...new Map((chat.data?.pages.slice().reverse().flat() ?? []).map(message => [message.id, message])).values()];
  const latestMessageId = messages.at(-1)?.id;
  const hasConversation = messages.some(message => message.type !== 'SYSTEM');
  const authorized = !access.data?.authorizationExpiresAt || Date.parse(access.data.authorizationExpiresAt) > Date.now();
  const ready = authorized && !checkFailed && !access.isError && access.data?.status === 'READY_FOR_SECURE_SESSION' && Boolean(access.data.secretStored && access.data.lastCheckedAt && !access.data.lastErrorCode);
  const canCapture = !care.isError && care.data?.capabilities.secureCapture === true;
  const hasActivity = Boolean(care.data?.jobs.length || care.data?.accessRequests.some(request => ['PENDING', 'APPROVED'].includes(request.status)));
  const refresh = async () => { await Promise.all([access.refetch(), chat.refetch(), assessment.refetch(), client.invalidateQueries({ queryKey: ['website', website.id] }), client.invalidateQueries({ queryKey: ['care', website.id] })]); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (ready) input.current?.focus({ preventScroll: true }); }, [ready]);
  useEffect(() => { if (followLatest.current) bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [latestMessageId, activity?.state]);
  async function inspect() {
    if (sending.current || !ready) return;
    sending.current = true; setBusy(true); setInspecting(true); setError(''); followLatest.current = true; previousScan.current = assessment.data?.scan?.id ?? null; cancelRequested.current = false; controller.current = new AbortController();
    try {
      // A deliberate customer action invokes the actual bounded assessment,
      // not a model-generated claim or a hidden production-change approval.
      await api(`${base}/assessment`, { method: 'POST', signal: controller.current.signal });
      if (alive.current) await refresh();
    } catch (caught) {
      if (alive.current) { if (!cancelRequested.current) setError(caught instanceof ApiClientError ? caught.message : 'The inspection connection ended. Review saved progress before starting another inspection.'); await refresh(); }
    } finally { sending.current = false; if (alive.current) { setBusy(false); setInspecting(false); } }
  }
  async function cancelInspection() {
    const scan = assessment.isError ? null : assessment.data?.scan;
    if (!scan || scan.status !== 'RUNNING' || cancellingRequest.current) return;
    cancellingRequest.current = true; setCancelling(true); setError('');
    try { await api(`${base}/assessment/${scan.id}/cancel`, { method: 'POST' }); cancelRequested.current = true; if (inspecting) controller.current?.abort(); await refresh(); }
    catch (caught) { if (alive.current) setError(caught instanceof ApiClientError ? caught.message : 'Cancellation could not be confirmed. Review saved activity.'); }
    finally { cancellingRequest.current = false; if (alive.current) setCancelling(false); }
  }
  async function send() {
    if (sending.current || !draft.trim()) return;
    if (sensitive(draft)) {
      setDraft(''); setConnectionOpen(true);
      setError('Access details were not sent. Use the secure SSH form, not chat.');
      return;
    }
    sending.current = true; setBusy(true); setError(''); const content = draft.trim(); setPendingMessage(content); setDraft(''); followLatest.current = true; controller.current = new AbortController();
    try {
      await api(`${base}/chat/ingest`, { method: 'POST', signal: controller.current.signal, body: JSON.stringify({ mode: 'MESSAGE', content, idempotencyKey: crypto.randomUUID() }) });
      if (!alive.current) return;
      await chat.refetch(); bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    } catch (caught) {
      if (!alive.current) return;
      setError(caught instanceof ApiClientError ? caught.message : 'The response connection ended. Check saved messages before retrying.');
      await chat.refetch();
    } finally { sending.current = false; if (alive.current) { setBusy(false); setPendingMessage(''); } }
  }
  return <section className={styles.chat} aria-label="Security recovery conversation">
    <header className={styles.header}>
      <Link href={`/customer/websites/${website.id}/services?service=security`} aria-label="Back to website services">←</Link>
      <div><h1>Fix hacks &amp; security</h1><p>{new URL(website.url).hostname}</p></div>
      <span className={styles.badge}>{ready ? 'SSH checked' : 'SSH needed'}</span>
    </header>
    <div className={styles.history} aria-label="Conversation history" tabIndex={0} onScroll={event => { const element = event.currentTarget; followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
      {!hasConversation && <div className={styles.intro}><BrandLogo variant="mark" decorative /><h2>Let’s help secure your website.</h2><p>Describe the issue. Inspect the evidence. Review the next step.</p></div>}
      {chat.hasNextPage && <button className={styles.secondary} disabled={chat.isFetchingNextPage} onClick={() => void chat.fetchNextPage()}>Load older messages</button>}
      {chat.isLoading && <p role="status">Loading saved conversation…</p>}
      {chat.isError && <p role="alert">Saved conversation is unavailable. <button className={styles.secondary} onClick={() => void chat.refetch()}>Retry conversation</button></p>}
      {messages.map(message => message.type === 'SYSTEM' ? <details className={styles.systemMessage} key={message.id}><summary>System update <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></summary><p>{message.content}</p></details> : <article className={`${styles.message} ${message.type === 'CUSTOMER' ? styles.customer : styles.assistant}`} key={message.id}>
        <div className={styles.author}><strong>{message.type === 'CUSTOMER' ? 'You' : message.type === 'AI' ? 'CodeBandage · AI' : message.type === 'SPECIALIST' ? `${message.author?.displayName ?? 'Specialist'} · Human` : 'CodeBandage · System'}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => <span>[Use a protected attachment for images]</span>, a: ({ href, children }) => href && /^(https?:\/\/|\/[^/]|#)/iu.test(href) ? <a href={href} rel="noopener noreferrer" target={href.startsWith('http') ? '_blank' : undefined}>{children}</a> : <span>{children}</span> }}>{message.content}</ReactMarkdown>
      </article>)}
      {(!ready || !hasConversation) && <article className={`${styles.message} ${styles.assistant}`} aria-label="Security intake guidance">
        <div className={styles.author}><strong>CodeBandage · Getting started</strong></div>
        {ready ? <><h2>What suspicious changes have you noticed?</h2><p>For example: redirects, unexpected pop-ups, changed pages or a malware warning. Describe it in one sentence, or choose Inspect website below.</p></> : <><h2>First, connect your SSH access securely.</h2><p>Use a dedicated server account for a website you own or administer. Never put a password or private key in this chat.</p><button className={styles.primary} aria-expanded={connectionOpen} aria-controls={`security-ssh-${website.id}`} disabled={busy} onClick={() => { setConnectionOpen(!connectionOpen); setError(''); }}>{connectionOpen ? 'Close secure SSH form' : 'Connect SSH securely'}</button><p className={styles.note}>You can describe the problem now. Connection checks and website changes are separate.</p></>}
      </article>}
      {ready && !connectionOpen && <button className={styles.secondary} aria-expanded={false} aria-controls={`security-ssh-${website.id}`} disabled={busy} onClick={() => setConnectionOpen(true)}>Manage SSH access</button>}
      {connectionOpen && <SecureSsh key={website.id} id={website.id} available={canCapture} loading={care.isLoading} access={access.isError ? null : access.data ?? null} onChanged={refresh} onChecked={() => { setCheckFailed(false); setConnectionOpen(false); }} onCheckFailed={() => setCheckFailed(true)} close={() => setConnectionOpen(false)} />}
      {access.isError && <p role="alert">SSH status could not be verified. <button className={styles.secondary} onClick={() => void access.refetch()}>Retry SSH status</button></p>}
      {pendingMessage && !messages.some(message => message.type === 'CUSTOMER' && message.content === pendingMessage) && <article className={`${styles.message} ${styles.customer}`} aria-label="Message being sent"><div className={styles.author}><strong>You</strong><span>Sending…</span></div><p>{pendingMessage}</p></article>}
      {activity && <SecurityAgentActivity {...activity} />}
      {!assessment.isError && assessment.data?.scan?.status === 'RUNNING' && <button className={styles.secondary} disabled={cancelling} aria-busy={cancelling} onClick={() => void cancelInspection()}>{cancelling ? 'Cancelling inspection…' : 'Cancel inspection'}</button>}
      <div ref={bottom} />
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {ready && <div className={styles.workflow}><div><button className={styles.secondary} disabled={busy || (!assessment.isError && assessment.data?.scan?.status === 'RUNNING')} onClick={() => void inspect()}>{inspecting ? 'Inspecting…' : 'Inspect website'}</button><Link href={`/customer/websites/${website.id}/findings`}>Review findings</Link></div><p>Inspect website authorizes a bounded SSH and public web assessment, not file changes. Live security repairs are not enabled in this deployment; a verified backup, supported repair runner and approval are required.</p></div>}
    <form className={styles.composer} aria-label="Message security assistant" onSubmit={event => { event.preventDefault(); void send(); }}>
      <label className="sr-only" htmlFor={`security-draft-${website.id}`}>Message CodeBandage</label>
      <textarea ref={input} id={`security-draft-${website.id}`} value={draft} disabled={busy} maxLength={4000} autoComplete="off" data-private="true" placeholder={ready ? 'Tell me what changed on your website…' : 'Describe the problem — no passwords or keys…'} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia('(min-width: 768px)').matches) { event.preventDefault(); void send(); } }} />
      <div><small>Keep access details in the secure form.</small><button className={styles.send} aria-label="Send message" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Send ↑'}</button></div>
    </form>
    <footer className={styles.footer}><span>We agree the scope first. You approve consequential changes.</span><Link href="/customer/support">Need human help?</Link>{hasActivity && <Link href={`/customer/websites/${website.id}`}>Review saved jobs &amp; approvals</Link>}</footer>
  </section>;
}

function SecureSsh({ id, available, loading, access, onChanged, onChecked, onCheckFailed, close }: { id: string; available: boolean; loading: boolean; access: Access | null; onChanged: () => Promise<void>; onChecked: () => void; onCheckFailed: () => void; close: () => void }) {
  const [host, setHost] = useState(''); const [port, setPort] = useState('22'); const [username, setUsername] = useState('');
  const [method, setMethod] = useState('PASSWORD'); const [secret, setSecret] = useState('');
  const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const sending = useRef(false); const alive = useRef(true); const controller = useRef<AbortController | null>(null);
  const base = `/websites/${id}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const changed = () => { setConsent(false); setError(''); };
  async function run(save: boolean) {
    if (sending.current || (save && (!available || !consent)) || (!save && !access?.secretStored)) return;
    sending.current = true; setBusy(true); setError(''); controller.current = new AbortController();
    const submittedSecret = secret; setSecret(''); setConsent(false);
    try {
      if (save) await api(`${base}/chat/ingest`, { method: 'POST', signal: controller.current.signal, body: JSON.stringify({ mode: 'SECURE', idempotencyKey: crypto.randomUUID(), content: JSON.stringify({ kind: 'SSH', host, port: Number(port), username, authMethod: method, firstConnectionTrustConfirmed: true, secret: submittedSecret }), environment: 'PRODUCTION', authorizationConfirmed: true }) });
      if (!alive.current) return;
      // Only authenticate the pinned SSH connection. Never enqueue assessment/repair.
      const checked = await api<Access>(`${base}/access/check`, { method: 'POST', signal: controller.current.signal });
      if (!alive.current) return;
      if (checked.status !== 'READY_FOR_SECURE_SESSION' || !checked.lastCheckedAt || checked.lastErrorCode) throw new Error('SSH was not verified. Check the saved connection before continuing.');
      await onChanged(); if (alive.current) onChecked();
    } catch (caught) {
      if (!alive.current) return;
      onCheckFailed();
      // Do not reflect server responses from sensitive operations or restore secrets.
      const safeErrors: Record<string, string> = { HOST_IDENTITY_REQUIRED: 'Save your SSH details again and confirm first-connection trust.', SSH_HOST_KEY_CHANGED: 'The saved server identity changed. Connection blocked: contact support and verify the change with your hosting provider.', SSH_AUTH_FAILED: 'The SSH server rejected the username, password or private key. Check these in your provider’s dashboard.', AUTHORIZATION_REQUIRED: 'SSH authorization expired or was revoked. Re-enter the account and approve a new check.', SSH_CHECK_IN_PROGRESS: 'A check is already running for this website. Wait for its result before retrying.', SSH_CHECK_LIMIT: 'SSH checks are busy. Please retry shortly.', SSH_ACCESS_CHANGED: 'The saved account changed during the check. Check the current saved account.', SSH_DNS_TIMEOUT: 'SSH DNS lookup timed out. Check the provider’s SSH hostname and retry.', SSH_TIMEOUT: 'The SSH server did not respond in time. Check the host, port and firewall, then retry.', SSH_CREDENTIAL_FORMAT: 'The private key format is not supported. Use a dedicated unencrypted SSH key or the password option.' };
      setError((caught instanceof ApiClientError ? safeErrors[caught.code] : undefined) ?? 'SSH setup or connection check failed. Check the saved status, server address, port and account details. No assessment or changes started.');
      await onChanged();
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  }
  return <section className={styles.ssh} id={`security-ssh-${id}`} aria-label="Secure SSH connection">
    <h2>Secure SSH connection</h2><p>Credentials go directly to encrypted storage, not to AI or conversation history.</p>
    {loading ? <p role="status">Checking secure capture availability…</p> : !available && <p role="alert">Secure capture is unavailable in this deployment. Do not enter credentials. Contact support; automated security work is not enabled.</p>}
    {access?.secretStored && <div className={styles.saved}><p>Stored access · {access.status.toLowerCase().replaceAll('_', ' ')}. Secret hidden.</p>{access.authorizationExpiresAt && <p>Authorization expires {new Date(access.authorizationExpiresAt).toLocaleString()}. Re-enter access and consent after expiry.</p>}<button className={styles.secondary} disabled={busy || !available || Boolean(access.authorizationExpiresAt && Date.parse(access.authorizationExpiresAt) <= Date.now())} onClick={() => void run(false)}>Check saved SSH connection</button><p><Link href={`/customer/websites/${id}/access?service=security`}>Review or revoke stored access</Link></p></div>}
    <form aria-label="Secure SSH form" onSubmit={event => { event.preventDefault(); void run(true); }}>
      <fieldset disabled={!available || busy}><legend className="sr-only">SSH account details</legend>
        <div className={styles.fields}><label>Server host<input required maxLength={253} pattern="[a-zA-Z0-9.\-]+" value={host} placeholder="SSH hostname or public IP" autoComplete="off" onChange={event => { setHost(event.target.value); changed(); }}/></label><label>SSH port<input required type="number" min={1} max={65535} value={port} onChange={event => { setPort(event.target.value); changed(); }}/></label></div>
        <p><small>Use the SSH host from your hosting provider. Your website domain may point to a CDN, not the SSH server.</small></p>
        <label>SSH username<input required maxLength={120} value={username} autoComplete="off" onChange={event => { setUsername(event.target.value); changed(); }}/></label>
        <label>{method === 'SSH_KEY' ? 'SSH private key' : 'SSH password'}{method === 'SSH_KEY' ? <textarea required maxLength={50000} value={secret} autoComplete="off" autoCorrect="off" spellCheck={false} data-private="true" onChange={event => { setSecret(event.target.value); changed(); }}/> : <input required type="password" maxLength={50000} value={secret} autoComplete="new-password" data-private="true" onChange={event => { setSecret(event.target.value); changed(); }}/>}</label>
        <button type="button" className={styles.secondary} onClick={() => { setMethod(method === 'PASSWORD' ? 'SSH_KEY' : 'PASSWORD'); setSecret(''); changed(); }}>{method === 'PASSWORD' ? 'Use a private key instead' : 'Use a password instead'}</button>
        <p className={styles.note}>The first connection trusts and saves this server’s identity. Later identity changes are blocked. No fingerprint typing needed.</p>
        <label className={styles.consent}><input required type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/><span>I own or administer this server and authorize encrypted storage, first-connection trust and an SSH connection check only. Changes need separate approval.</span></label>
        <button className={styles.primary} disabled={busy || !consent || !host || !username || !secret}>{busy ? 'Connecting…' : 'Connect SSH'}</button>
      </fieldset>
    </form>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <button className={styles.secondary} disabled={busy} onClick={() => { setSecret(''); setConsent(false); close(); }}>Cancel SSH setup</button>
  </section>;
}
