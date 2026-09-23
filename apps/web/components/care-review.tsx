'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export type ReviewRole = { id: string; name: string; implementation: string };
type SourceFile = { path: string; content: string };
type Report = { agentRunId: string; roleId: string; status: string; summary: string; findings: Array<{ title: string; priority: string; explanation: string; recommendation: string; evidence: Array<{ path: string; startLine: number; endLine: number; quote: string }> }>; limitations: string[]; nextSteps: string[] };
type ReviewState = {
  job: { id: string; state: string; summary: string; errorCode: string | null };
  revision: { id: string; version: number; state: string; sourceDigest: string; budgetMicros: number; chargedMicros: number; budgetState: string; plan: { roleIds: string[]; language: string; boundary: string; requestFingerprint: string; configuration: { model: string } } };
  reports: Report[]; agents: Array<{ id: string; roleId: string; state: string; errorCode: string | null }>;
  completedSteps: number; totalSteps: number;
  capabilities: { enabled: boolean };
};
const dollars = (value: number) => `$${(value / 1_000_000).toFixed(3)}`;
const stateLabel = (value: string) => value.toLowerCase().replaceAll('_', ' ');

export function CareReviewForm({ websiteId, environment, roles, maximumBudgetMicros, onDone }: { websiteId: string; environment: string; roles: ReviewRole[]; maximumBudgetMicros: number; onDone: () => void }) {
  const client = useQueryClient();
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [selected, setSelected] = useState(roles.map((role) => role.id));
  const [summary, setSummary] = useState(''); const [expected, setExpected] = useState('');
  const [language, setLanguage] = useState('en'); const [budget, setBudget] = useState(String(maximumBudgetMicros / 1_000_000));
  const [privacy, setPrivacy] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function chooseFiles(list: FileList | null) {
    setError(''); setPrivacy(false); setFiles([]);
    const selectedFiles = Array.from(list ?? []);
    if (!selectedFiles.length) return;
    if (selectedFiles.length > 30 || selectedFiles.reduce((total, file) => total + file.size, 0) > 200000) { setError('Choose up to 30 text files with a combined size below 200 KB.'); return; }
    setBusy(true);
    try { setFiles(await Promise.all(selectedFiles.map(async (file) => ({ path: file.webkitRelativePath || file.name, content: new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) })))); }
    catch { setError('These files could not be read as UTF-8 text.'); }
    finally { setBusy(false); }
  }
  async function prepare() {
    setBusy(true); setError('');
    try {
      await api(`/websites/${websiteId}/reviews`, { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), summary, expectedBehavior: expected, environment, language, roleIds: selected, files, privacyReviewed: privacy, budgetMicros: Math.round(Number(budget) * 1_000_000) }) });
      setFiles([]); setSummary(''); setExpected('');
      await client.invalidateQueries({ queryKey: ['care', websiteId] }); onDone();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The review plan could not be prepared.'); }
    finally { setBusy(false); }
  }
  return <form className="care-panel care-issue-form" aria-label="New source review" onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
    <h3>Ask your AI team to review source</h3>
    <p>Select the roles and reviewed text files for this case. You will approve the plan before model work starts. This review produces cited advice; it does not run code, apply repairs or contact your live website.</p>
    <label>What should the team review?<textarea required minLength={10} maxLength={1000} value={summary} onChange={(event) => setSummary(event.target.value)}/></label>
    <label>Expected outcome<textarea required minLength={10} maxLength={4000} value={expected} onChange={(event) => setExpected(event.target.value)}/></label>
    <label>Report language<select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="en">English</option><option value="ta">தமிழ்</option></select></label>
    <fieldset><legend>Assigned source-review roles · {selected.length} selected</legend>
      <div className="care-inline-actions"><button type="button" onClick={() => setSelected(roles.map((role) => role.id))}>Select all 24 roles</button><button type="button" onClick={() => setSelected(['A01','A03','A05','A14','A18'])}>Select core review team</button></div>
      <div className="care-review-roles">{roles.map((role) => <label key={role.id}><input type="checkbox" checked={selected.includes(role.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, role.id] : selected.filter((id) => id !== role.id))}/><span>{role.id} · {role.name}</span></label>)}</div>
    </fieldset>
    <label>Reviewed text source files<input type="file" multiple disabled={busy} onChange={(event) => { void chooseFiles(event.target.files); event.target.value = ''; }}/></label>
    <p className="care-small">Up to 30 UTF-8 files and 200 KB including metadata. No archives, credentials or private customer records. Adjust duplicate filenames to their relative project paths.</p>
    {files.map((file, index) => <label key={index}>Source path {index + 1}<input required aria-label={`Source path ${index + 1}`} maxLength={180} value={file.path} onChange={(event) => setFiles(files.map((item, position) => position === index ? { ...item, path: event.target.value } : item))}/></label>)}
    <label>Maximum review model allowance (USD)<input type="number" min="0.001" step="0.001" max={maximumBudgetMicros / 1_000_000} required value={budget} onChange={(event) => setBudget(event.target.value)}/></label>
    <label className="care-consent"><input type="checkbox" checked={privacy} onChange={(event) => setPrivacy(event.target.checked)}/>I reviewed these files, removed credentials and private data, and am authorized to submit them to the configured AI provider after approval.</label>
    {error && <p className="care-alert" role="alert">{error}</p>}
    <button disabled={busy || !privacy || !files.length || !selected.length}>{busy ? 'Preparing…' : 'Prepare team review plan'}</button>
  </form>;
}

export function CareReview({ jobId, websiteId, roles }: { jobId: string; websiteId: string; roles: ReviewRole[] }) {
  const client = useQueryClient(); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const query = useQuery({ queryKey: ['care-review', websiteId, jobId], queryFn: () => api<ReviewState>(`/jobs/${jobId}/review`), enabled: open, refetchInterval: open ? 5000 : false, retry: false });
  async function approve() {
    if (!query.data) return;
    const { revision } = query.data; setBusy(true); setError('');
    try {
      await api(`/review-plans/${revision.id}/approve`, { method: 'POST', body: JSON.stringify({ sourceDigest: revision.sourceDigest, planFingerprint: revision.plan.requestFingerprint, version: revision.version, budgetMicros: revision.budgetMicros, authorizeSourceReview: true }) });
      await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: ['care', websiteId] })]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Approval failed.'); }
    finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true); setError('');
    try { await api(`/jobs/${jobId}/cancel`, { method: 'POST' }); await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: ['care', websiteId] })]); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The stop request failed.'); }
    finally { setBusy(false); }
  }
  const data = query.data;
  return <section className="care-review-workspace"><button aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close team review' : 'Open team review'}</button>
    {open && <div className="care-panel">
      {query.isLoading && <p role="status">Loading review plan and reports…</p>}
      {(error || query.error) && <p role="alert" className="care-alert">{error || query.error?.message}</p>}
      {data && <>
        <h4>{data.totalSteps} roles · {data.completedSteps} completed reviews</h4>
        <p>{data.revision.plan.boundary}</p>
        <p>Model: {data.revision.plan.configuration.model}. Allowance: {dollars(data.revision.budgetMicros)}. Recorded model cost: {dollars(data.revision.chargedMicros)} · {stateLabel(data.revision.budgetState)}.</p>
        <p>Selected roles: {data.revision.plan.roleIds.join(', ')}. Report language: {data.revision.plan.language === 'ta' ? 'தமிழ்' : 'English'}.</p>
        <details><summary>Approved source fingerprint</summary><code className="care-digest">{data.revision.sourceDigest}</code></details>
        {data.job.state === 'AWAITING_APPROVAL' && <button disabled={busy || !data.capabilities.enabled} onClick={() => void approve()}>Approve source review · up to {dollars(data.revision.budgetMicros)}</button>}
        {['AWAITING_APPROVAL','QUEUED','RUNNING','WAITING_FOR_INPUT'].includes(data.job.state) && <button disabled={busy} onClick={() => void cancel()}>Stop team review</button>}
        {data.job.errorCode && <p role="status">Review stopped: {stateLabel(data.job.errorCode)}. Completed reports remain available; prepare a new plan for any further work.</p>}
        {data.agents.length > 0 && <ol className="care-review-progress">{data.agents.map((agent) => <li key={agent.id}>{agent.roleId} · {roles.find((role) => role.id === agent.roleId)?.name} — {stateLabel(agent.state)}{agent.errorCode ? ` (${stateLabel(agent.errorCode)})` : ''}</li>)}</ol>}
        {data.reports.map((report) => <article className="care-agent" key={report.agentRunId}>
          <h4>{report.roleId} · {roles.find((role) => role.id === report.roleId)?.name}</h4><p>{stateLabel(report.status)} · source quotes checked · runtime tests not run</p><p>{report.summary}</p>
          {report.findings.map((finding, index) => <details key={index}><summary>{finding.priority} · {finding.title}</summary><p>{finding.explanation}</p><p>Recommendation: {finding.recommendation}</p>{finding.evidence.map((evidence, position) => <figure key={position}><figcaption>{evidence.path} · lines {evidence.startLine}–{evidence.endLine}</figcaption><pre className="care-review-quote">{evidence.quote}</pre></figure>)}</details>)}
          <p>Limitations</p><ul>{report.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
          {report.nextSteps.length > 0 && <><p>Suggested next steps</p><ul>{report.nextSteps.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
        </article>)}
        {data.completedSteps > data.reports.length && <p>Some saved reports are expired or unavailable. Their completion records do not restore expired artifact content.</p>}
      </>}
    </div>}
  </section>;
}
