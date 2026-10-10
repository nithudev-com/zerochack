'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { websiteServices as tasks, websiteWorkspaceHref, type WebsiteService } from '../lib/website-services';
import styles from './website-task-panel.module.css';
import { WebsiteServiceIcon } from './website-service-icon';
const compactDescriptions: Record<WebsiteService['id'], string> = { security: 'Recovery & protection', development: 'Frontend & backend', redesign: 'Layout, brand & mobile', issue: 'Bugs & broken pages', server: 'Hosting & deployment', seo: 'Search & page metadata', automation: 'Workflows & integrations' };

export function WebsiteTaskPanel({ website, environment, service, state, capabilities, onReview }: {
  website: { id: string; name: string; url: string }; environment: string;
  service?: WebsiteService;
  state: 'loading' | 'disabled' | 'unavailable' | 'available';
  capabilities: { sourceReview?: boolean; isolatedRepair: boolean; deployment: boolean } | undefined;
  onReview: () => void;
}) {
  const client = useQueryClient(); const sending = useRef(false);
  const [task, setTask] = useState<number | null>(() => service ? tasks.findIndex(item => item.id === service.id) : null); const [goal, setGoal] = useState(''); const [acceptance, setAcceptance] = useState('');
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false); const [error, setError] = useState('');
  const disabled = state === 'disabled';
  const source = state === 'available' && capabilities?.sourceReview === true;
  const status = (enabled: boolean | undefined) => state === 'loading' ? 'Checking availability' : state === 'unavailable' ? 'Status unavailable' : disabled || !enabled ? 'Disabled in this deployment' : 'Enabled gate · job checks still required';
  async function save() {
    if (sending.current || task === null || !confirmed) return;
    if (/-----BEGIN .*PRIVATE KEY-----|\b(?:password|passwd|pwd|secret|token|api[_ -]?key)\s*[:=]\s*\S+|\bBearer\s+\S+|\bsk-[\w-]{12,}/iu.test(`${goal}\n${acceptance}`)) { setError('This appears to contain access information. Remove it and use Connections; never include credentials in a task brief.'); return; }
    sending.current = true; setBusy(true); setError('');
    try {
      await api('/support/conversations', { method: 'POST', body: JSON.stringify({ subject: `${tasks[task]!.name}: ${website.name}`.slice(0, 240), message: `Website origin: ${new URL(website.url).origin}\nWebsite ID: ${website.id}\nEnvironment: ${environment}\nService: ${tasks[task]!.id} · ${tasks[task]!.label}\nTask: ${tasks[task]!.name}\n\nRequested work:\n${goal}\n\nAcceptance checks:\n${acceptance}\n\nScope request only. No permission to execute code, spend on a model, disclose credentials or deploy changes.` }) });
      setSaved(true); setTask(null); setGoal(''); setAcceptance(''); setConfirmed(false);
      void client.invalidateQueries({ queryKey: ['support-conversations'] });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the request. Check Support before retrying to avoid duplicates.'); }
    finally { sending.current = false; setBusy(false); }
  }
  return <section className={`care-panel ${styles.panel}`} aria-label="Website tasks and tools">
    <div className={`care-panel-heading ${styles.heading}`}><div><span className={styles.eyebrow}>YOUR NEXT PROJECT</span><h3>{service ? `${service.label} workspace` : 'What would you like to build or improve?'}</h3></div><Link href={websiteWorkspaceHref(website.id, service, '/access')}>Connections →</Link></div>
    {service ? <div className={styles.context}><span>Step 2 of 2 · Scope your request</span><Link href={websiteWorkspaceHref(website.id, service, '/services')}>Change service</Link><p>{service.description}</p><p>{service.boundary}</p></div> : <><p className={styles.intro}>One workspace for your whole website. Choose the work, describe the result, then review the next step.</p><div className={styles.services} aria-label="Website work types">{tasks.map((item, index) => <button className={styles.service} key={item.id} type="button" aria-label={item.label} aria-pressed={task === index} disabled={busy} onClick={() => { setTask(index); setGoal(''); setAcceptance(''); setSaved(false); setConfirmed(false); setError(''); }}><span className={styles.icon}><WebsiteServiceIcon service={item.id}/></span><span className={styles.serviceCopy}><strong>{item.label}</strong><small className={styles.description}>{item.description}</small><small className={styles.compactDescription}>{compactDescriptions[item.id]}</small></span><span className={styles.arrow} aria-hidden="true">↗</span></button>)}</div></>}
    <p className={styles.scopeNote}>Selecting a service starts a brief, not a website change. Send it for human review when you’re ready.</p>
    {service && task === null && !saved && <button type="button" onClick={() => setTask(tasks.findIndex(item => item.id === service.id))}>Start service request</button>}
    {task !== null && <form className="care-issue-form" aria-label="Website task brief" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h3>{tasks[task]!.name}</h3><p>{tasks[task]!.hint} No passwords, keys or private customer data.</p>
      <label htmlFor={`website-task-goal-${website.id}`}>Requested work</label><textarea id={`website-task-goal-${website.id}`} required minLength={10} maxLength={900} disabled={busy} value={goal} onChange={event => { setGoal(event.target.value); setConfirmed(false); }} />
      <label htmlFor={`website-task-acceptance-${website.id}`}>How should we verify success?</label><textarea id={`website-task-acceptance-${website.id}`} required minLength={10} maxLength={1200} placeholder={tasks[task]!.success} disabled={busy} value={acceptance} onChange={event => { setAcceptance(event.target.value); setConfirmed(false); }} />
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I reviewed this brief, removed secrets and want to send it to the support team for scoping.</label>
      <div className="care-inline-actions"><button type="submit" disabled={!confirmed || busy}>{busy ? 'Saving request…' : 'Save request for human review'}</button><button type="button" disabled={busy} onClick={() => { setTask(null); setGoal(''); setAcceptance(''); setConfirmed(false); setError(''); }}>Cancel brief</button></div>
    </form>}
    {saved && <p role="status">Request saved in Support. No AI execution or website changes started. <Link href="/customer/support">Open saved conversation</Link></p>}
    {error && <p role="alert">{error}</p>}
    {service && <nav className={styles.related} aria-label="Service workspace resources">{service.links.map(link => <Link key={link.path} href={websiteWorkspaceHref(website.id, service, link.path)}>{link.label} →</Link>)}</nav>}
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
      <p>Chat can help scope development, design, fixes, server work, SEO, automation and security. Advice is not execution: only available, authorized tools can act. Unsupported platform integrations are labelled guide-only in Connections.</p>
    </details>
  </section>;
}
