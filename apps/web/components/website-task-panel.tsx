'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import styles from './website-task-panel.module.css';

const tasks = [
  { name: 'Develop a feature', hint: 'Describe the feature, the pages it affects and who will use it.' },
  { name: 'Redesign a page', hint: 'Describe the layout, mobile behaviour and visual result you want.' },
  { name: 'Fix an issue', hint: 'Include steps to reproduce, what happens now and what should happen.' }
] as const;
export function WebsiteTaskPanel({ website, environment, state, capabilities, onReview }: {
  website: { id: string; name: string; url: string }; environment: string;
  state: 'loading' | 'disabled' | 'unavailable' | 'available';
  capabilities: { sourceReview?: boolean; isolatedRepair: boolean; deployment: boolean } | undefined;
  onReview: () => void;
}) {
  const client = useQueryClient(); const sending = useRef(false);
  const [task, setTask] = useState<number | null>(null); const [goal, setGoal] = useState(''); const [acceptance, setAcceptance] = useState('');
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false); const [error, setError] = useState('');
  const disabled = state === 'disabled';
  const source = state === 'available' && capabilities?.sourceReview === true;
  const status = (enabled: boolean | undefined) => state === 'loading' ? 'Checking availability' : state === 'unavailable' ? 'Status unavailable' : disabled || !enabled ? 'Disabled in this deployment' : 'Enabled gate · job checks still required';
  async function save() {
    if (sending.current || task === null || !confirmed) return;
    if (/-----BEGIN .*PRIVATE KEY-----|\b(?:password|passwd|pwd|secret|token|api[_ -]?key)\s*[:=]\s*\S+|\bBearer\s+\S+|\bsk-[\w-]{12,}/iu.test(`${goal}\n${acceptance}`)) { setError('This appears to contain access information. Remove it and use Connections; never include credentials in a task brief.'); return; }
    sending.current = true; setBusy(true); setError('');
    try {
      await api('/support/conversations', { method: 'POST', body: JSON.stringify({ subject: `${tasks[task]!.name}: ${website.name}`.slice(0, 240), message: `Website origin: ${new URL(website.url).origin}\nWebsite ID: ${website.id}\nEnvironment: ${environment}\nTask: ${tasks[task]!.name}\n\nRequested work:\n${goal}\n\nAcceptance checks:\n${acceptance}\n\nScope request only. No permission to execute code, spend on a model, disclose credentials or deploy changes.` }) });
      setSaved(true); setTask(null); setGoal(''); setAcceptance(''); setConfirmed(false);
      void client.invalidateQueries({ queryKey: ['support-conversations'] });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the request. Check Support before retrying to avoid duplicates.'); }
    finally { sending.current = false; setBusy(false); }
  }
  return <section className={`care-panel ${styles.panel}`} aria-label="Website tasks and tools">
    <div className="care-panel-heading"><h3>What would you like to work on?</h3><Link href={`/customer/websites/${website.id}/access`}>Connections →</Link></div>
    <div className="care-inline-actions">{tasks.map((item, index) => <button key={item.name} type="button" aria-pressed={task === index} disabled={busy} onClick={() => { setTask(index); setSaved(false); setConfirmed(false); setError(''); }}>{item.name}</button>)}</div>
    <p>Prepare a scoped request for human review. AI source review is separate; connecting a site does not start edits.</p>
    {task !== null && <form className="care-issue-form" aria-label="Website task brief" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h3>{tasks[task]!.name}</h3><p>{tasks[task]!.hint} No passwords, keys or private customer data.</p>
      <label>Requested work<textarea required minLength={10} maxLength={900} disabled={busy} value={goal} onChange={event => { setGoal(event.target.value); setConfirmed(false); }} /></label>
      <label>How should we verify success?<textarea required minLength={10} maxLength={1200} disabled={busy} value={acceptance} onChange={event => { setAcceptance(event.target.value); setConfirmed(false); }} /></label>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I reviewed this brief, removed secrets and want to send it to the support team for scoping.</label>
      <div className="care-inline-actions"><button type="submit" disabled={!confirmed || busy}>{busy ? 'Saving request…' : 'Save request for human review'}</button><button type="button" disabled={busy} onClick={() => { setTask(null); setGoal(''); setAcceptance(''); setConfirmed(false); setError(''); }}>Cancel brief</button></div>
    </form>}
    {saved && <p role="status">Request saved in Support. No AI execution or website changes started. <Link href="/customer/support">Open saved conversation</Link></p>}
    {error && <p role="alert">{error}</p>}
    <details><summary>Tools & availability</summary>
      <p>{disabled ? 'Care workflows are disabled on this server. The Owner must complete provider, authorization and runtime validation before activation.' : state === 'unavailable' ? 'Tool availability could not be verified. Retry the workspace; no tool is assumed ready.' : 'Flags are not proof of a working provider or runner. Each job still needs its own prerequisites, consent and results.'}</p>
      <dl>
        <dt>AI source review</dt><dd>{status(capabilities?.sourceReview)}. Reviewed source files, configured provider/model, budget and exact plan approval required.</dd>
        <dt>Text edits, saved versions, snapshot lint & types</dt><dd>{status(capabilities?.sourceReview)}. Open a text workspace from an approved source revision. Static checks do not run your application.</dd>
        <dt>Automated repair</dt><dd>{status(capabilities?.isolatedRepair)}. Requires scoped source, an isolated runtime and a reviewed repair plan.</dd>
        <dt>Browser & runtime verification</dt><dd>{disabled ? 'Disabled with Care.' : 'Not verified here; check the individual job preflight.'} No customer code runs on the application host.</dd>
        <dt>Production release</dt><dd>{status(capabilities?.isolatedRepair && capabilities?.deployment)}. Separate release authorization and recovery evidence required.</dd>
      </dl>
      <button type="button" disabled={!source} onClick={onReview}>Prepare AI source review</button>
      <p>The existing chat assistant explains saved website/security evidence. A development brief does not expand its execution tools. Unsupported platform integrations are labelled guide-only in Connections.</p>
    </details>
  </section>;
}
