'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api, ApiClientError } from '../lib/api';
import { canRetainQueryData, pollingInterval, queryRetry } from '../lib/query-policy';
import styles from './security-repair.module.css';

// Validate the safe product DTO. Never import server orchestration, access
// envelopes or executable manifests into the browser bundle.
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const stamp = z.iso.datetime();
const enrollment = z.object({ id: uuid, revision: z.number().int().positive(), label: z.string().min(1).max(120), environment: z.literal('STAGING'), adapter: z.literal('MANAGED_STATIC_PERMISSION_V1') });
const capabilitiesSchema = z.object({
  environment: z.literal('STAGING'), productionWrites: z.literal(false),
  tracks: z.array(z.object({ id: z.string(), label: z.string(), available: z.boolean() })),
  enrollments: z.array(enrollment), blockers: z.array(z.object({ code: z.string(), message: z.string() })),
  authority: z.object({ canCreate: z.boolean(), requiresRecentMfa: z.boolean() })
});
const runSchema = z.object({ id: uuid, environment: z.literal('STAGING'), phase: z.string().min(1), errorCode: z.string().nullable(), allowanceMicros: z.number().int().nonnegative(), reservedMicros: z.number().int().nonnegative(), chargedMicros: z.number().int().nonnegative(), createdAt: stamp, expiresAt: stamp, sessionBound: z.boolean() });
const evidenceSchema = z.object({
  artifactId: uuid, digest, version: z.literal(1), kind: z.enum(['PLAN', 'PROPOSAL', 'RESULT']), adapter: z.literal('MANAGED_STATIC_PERMISSION_V1'), summary: z.string().min(1).max(1000), environment: z.literal('STAGING'), enrollmentId: uuid, enrollmentRevision: z.number().int().positive(),
  change: z.object({ action: z.enum(['HARDEN', 'RESTORE']), targetLabel: z.string().min(1).max(120), beforeMode: z.number().int().min(0).max(511), afterMode: z.number().int().min(0).max(511), contentDigest: digest, preimageDigest: digest }),
  recovery: z.object({ digest, encrypted: z.literal(true), verified: z.boolean() }), checks: z.array(z.object({ name: z.string().min(1).max(120), passed: z.boolean() })).max(30)
}).refine(value => value.change.action === 'HARDEN' ? Boolean(value.change.beforeMode & 0o002) && value.change.afterMode === (value.change.beforeMode & ~0o002) : !(value.change.beforeMode & 0o002) && value.change.afterMode === (value.change.beforeMode | 0o002), 'The exact supported permission difference is required.');
const detailSchema = z.object({
  run: runSchema, awaitingDecision: z.enum(['CANDIDATE', 'CHANGE']).nullable(),
  attempts: z.array(z.object({ stepKey: z.string(), state: z.string(), errorCode: z.string().nullable(), artifactId: uuid.nullable(), artifactDigest: digest.nullable(), completedAt: stamp.nullable() })),
  decisions: z.array(z.object({ id: uuid, kind: z.string(), status: z.string(), artifactId: uuid, digest, expiresAt: stamp })),
  plan: evidenceSchema.nullable(), proposal: evidenceSchema.nullable(), result: evidenceSchema.nullable().optional()
});
type Evidence = z.infer<typeof evidenceSchema>;
type Run = z.infer<typeof runSchema>;
type Detail = z.infer<typeof detailSchema>;
type DecisionKind = 'CANDIDATE' | 'CHANGE';
const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'STALE', 'OUTCOME_UNKNOWN']);
const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const amount = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;
const date = (value: string) => new Date(value).toLocaleString();
function actionError(error: unknown) {
  if (error instanceof ApiClientError && error.status === 429) return 'This action is paused temporarily. Check the saved run before trying again; nothing will be sent automatically.';
  if (error instanceof ApiClientError && error.status === 403) return 'This action is not authorized. Verify your identity and refresh availability. The server also checks your current account, access grant and subscription.';
  if (error instanceof ApiClientError && error.status === 409) return 'The saved run or its authority changed. Refresh and review the current evidence before trying again.';
  return 'The action could not be confirmed. Review the saved run before trying again. No action will be replayed automatically.';
}

export function SecurityRepair({ websiteId }: { websiteId: string }) {
  const base = `/websites/${websiteId}/security-repair`;
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedEnrollment, setSelectedEnrollment] = useState('');
  const [selectedRun, setSelectedRun] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const sending = useRef(false);
  const alive = useRef(true);
  const requestKeys = useRef(new Map<string, string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const capabilities = useQuery({ queryKey: ['security-repair-capabilities', websiteId], queryFn: async ({ signal }) => capabilitiesSchema.parse(await api(base + '/capabilities', { signal })), enabled: open, retry: queryRetry, refetchInterval: query => open ? pollingInterval(query, 30000) : false });
  const runs = useQuery({ queryKey: ['security-repair-runs', websiteId], queryFn: async ({ signal }) => z.object({ runs: z.array(runSchema) }).parse(await api(base + '/runs', { signal })), enabled: open, retry: queryRetry, refetchInterval: query => open ? pollingInterval(query, 10000) : false });
  const runId = selectedRun || runs.data?.runs[0]?.id || '';
  const detail = useQuery({ queryKey: ['security-repair-run', websiteId, runId], queryFn: async ({ signal }) => { const result = detailSchema.parse(await api(`${base}/runs/${runId}`, { signal })); if (result.run.id !== runId) throw new Error('The saved run does not match.'); return result; }, enabled: open && Boolean(runId), retry: queryRetry, refetchInterval: query => open && !terminal.has(query.state.data?.run.phase ?? '') ? pollingInterval(query, 4000) : false });
  const available = !capabilities.isError ? capabilities.data : undefined;
  const canReadSaved = canRetainQueryData(capabilities.error) && canRetainQueryData(runs.error) && canRetainQueryData(detail.error);
  const savedRuns = canReadSaved ? runs.data?.runs : undefined;
  const saved = canReadSaved ? detail.data : undefined;
  const selected = available?.enrollments.find(item => item.id === selectedEnrollment);
  const createEnabled = Boolean(selected && available?.authority.canCreate && available.tracks.some(track => track.id === 'managed-static-permission-v1' && track.available) && !capabilities.isError && !runs.isError);
  const current = saved?.run;
  const canAct = Boolean(current?.sessionBound && Date.parse(current.expiresAt) > Date.now() && available && !available.authority.requiresRecentMfa && !detail.isError && !runs.isError);
  const canApprove = canAct && available?.authority.canCreate === true;
  function key(intent: string) { let value = requestKeys.current.get(intent); if (!value) { value = crypto.randomUUID(); requestKeys.current.set(intent, value); } return value; }
  const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
  async function refresh() {
    await Promise.allSettled([capabilities.refetch(), runs.refetch(), ...(runId ? [detail.refetch()] : []), client.invalidateQueries({ queryKey: ['chat', websiteId] }), client.invalidateQueries({ queryKey: ['security-assessment', websiteId] })]);
  }
  async function perform(task: () => Promise<void>) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(''); setNotice('');
    try { await task(); }
    catch (caught) { if (alive.current) setError(actionError(caught)); }
    finally {
      if (alive.current) { await refresh(); if (alive.current) setBusy(false); }
      sending.current = false;
    }
  }
  async function create() {
    if (!selected || !createEnabled || !authorized) return;
    const result = z.object({ run: runSchema, created: z.boolean() }).parse(await post(base + '/runs', { requestKey: key(`create:${selected.id}:${selected.revision}`), enrollmentId: selected.id, enrollmentRevision: selected.revision, authorizationConfirmed: true }));
    requestKeys.current.delete(`create:${selected.id}:${selected.revision}`);
    if (alive.current) { setSelectedRun(result.run.id); setAuthorized(false); setNotice('The staging run was saved. Review its exact plan before approving candidate work.'); }
  }
  async function decide(kind: DecisionKind, evidence: Evidence, status: 'APPROVED' | 'DENIED') {
    if (!current || !canAct || status === 'APPROVED' && !canApprove || saved?.awaitingDecision !== kind) return;
    z.object({ decisionId: uuid }).parse(await post(`${base}/runs/${current.id}/${kind === 'CANDIDATE' ? 'candidate' : 'change'}-decisions`, { requestKey: key(`decision:${current.id}:${kind}:${evidence.artifactId}:${evidence.digest}:${status}`), artifactId: evidence.artifactId, digest: evidence.digest, status }));
    if (alive.current) setNotice(status === 'APPROVED' ? 'The exact approval was saved. Worker progress will appear below.' : 'The decision was saved. Review the run for confirmed cancellation.');
  }
  async function cancel() {
    if (!current || !canAct) return;
    const result = z.object({ phase: z.string(), recorded: z.boolean(), effectsUndone: z.literal(false) }).parse(await post(`${base}/runs/${current.id}/cancel`, { requestKey: key(`cancel:${current.id}`) }));
    if (alive.current) setNotice(result.recorded ? 'Cancellation was recorded. It does not undo completed effects. Review the saved outcome below.' : 'Cancellation could not be confirmed. Review the saved outcome; no retry has been sent. Completed effects are not undone.');
  }
  const recoveryEnrollment = available?.enrollments.find(item => item.id === saved?.result?.enrollmentId && item.revision === saved.result.enrollmentRevision);
  const canPrepareRecovery = Boolean(saved?.run.phase === 'COMPLETED' && saved.result?.change.action === 'HARDEN' && saved.result.recovery.verified && recoveryEnrollment && available?.authority.canCreate && !runs.isError && !detail.isError);
  async function prepareRecovery() {
    if (!canPrepareRecovery || !current || !recoveryEnrollment) return;
    const intent = `restore:${current.id}:${recoveryEnrollment.id}:${recoveryEnrollment.revision}`;
    const result = z.object({ run: runSchema, created: z.boolean() }).parse(await post(base + '/runs', { requestKey: key(intent), operation: 'RESTORE', recoveryRunId: current.id, enrollmentId: recoveryEnrollment.id, enrollmentRevision: recoveryEnrollment.revision, authorizationConfirmed: true }));
    requestKeys.current.delete(intent);
    if (alive.current) { setSelectedRun(result.run.id); setNotice('A separate restoration plan was saved. Review and approve its candidate work and exact staging change before any restoration.'); }
  }
  async function verifyIdentity() {
    const code = mfaCode; setMfaCode('');
    await post('/auth/mfa/step-up', { code });
    if (alive.current) setNotice('Identity verified. Availability is being checked again. No repair was approved.');
  }
  return <section className={styles.workspace} aria-label="Security repair workspace">
    <button className={styles.toggle} aria-expanded={open} aria-controls={`security-repair-${websiteId}`} onClick={() => setOpen(!open)}><span>{open ? 'Close security repairs' : 'Review security repairs'}</span><span className={styles.scope}>STAGING ONLY</span></button>
    {open && <div className={styles.body} id={`security-repair-${websiteId}`}>
      <p className={styles.eyebrow}>SECURITY WORKPLACE · REVIEW &amp; APPROVE</p>
      <h2>Review each step before a change.</h2>
      <p>Supported work: remove the “other users can write” permission from one operator-enrolled staging file, with separately approved restoration. File contents stay the same. This does not enable malware removal, WordPress cleanup, arbitrary coding or production changes.</p>
      {(capabilities.isLoading || runs.isLoading) && <p role="status">Checking repair availability and saved runs…</p>}
      {(capabilities.isError || runs.isError) && <p className={styles.error} role="alert">Repair availability or saved runs could not be verified. New work is blocked. <button className={styles.secondary} disabled={busy || capabilities.isFetching || runs.isFetching} onClick={() => void refresh()}>Refresh repair availability</button></p>}
      {available && <>
        {available.blockers.length > 0 && <div className={styles.notice} role="status"><strong>Before this can run</strong><ul>{available.blockers.map(blocker => <li key={blocker.code}>{blocker.message}</li>)}</ul></div>}
        <form className={styles.form} aria-label="Verify repair identity" onSubmit={event => { event.preventDefault(); void perform(verifyIdentity); }}>
          <label className={styles.code}>Six-digit authenticator code<input value={mfaCode} onChange={event => setMfaCode(event.target.value.replace(/\D/gu, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" type="password" pattern="[0-9]{6}" maxLength={6} required data-private="true" disabled={busy}/></label>
          <div className={styles.actions}><button className={styles.secondary} disabled={busy || mfaCode.length !== 6}>Verify identity for repair actions</button><Link href="/customer/profile">Set up an authenticator</Link></div>
          <p className={styles.muted}>Approvals require current permissions and recent MFA. Verifying your identity does not approve a change.</p>
        </form>
        <form className={styles.form} aria-label="Start staging security plan" onSubmit={event => { event.preventDefault(); void perform(create); }}>
          <label>Enrolled staging target<select value={selectedEnrollment} disabled={busy || !available.enrollments.length} onChange={event => { setSelectedEnrollment(event.target.value); setAuthorized(false); setError(''); }} required><option value="">Choose an enrolled target</option>{available.enrollments.map(item => <option key={item.id} value={item.id}>{item.label} · revision {item.revision}</option>)}</select></label>
          {!available.enrollments.length && <p className={styles.muted}>No managed staging target is enrolled. A trusted operator must configure it before this workflow can run.</p>}
          <label className={styles.consent}><input type="checkbox" checked={authorized} disabled={busy || !createEnabled} onChange={event => setAuthorized(event.target.checked)}/><span>I authorize a read-only plan for this enrolled staging target. Candidate work and file changes require separate approval.</span></label>
          <div className={styles.actions}><button className={styles.primary} disabled={busy || !createEnabled || !authorized}>Prepare staging plan</button><button type="button" className={styles.secondary} disabled={busy || capabilities.isFetching || runs.isFetching} onClick={() => void refresh()}>Refresh saved work</button></div>
        </form>
      </>}
      {savedRuns && savedRuns.length > 0 && <div className={styles.form}><label>Saved security run<select value={runId} disabled={busy} onChange={event => { setSelectedRun(event.target.value); setError(''); setNotice(''); }}>{savedRuns.map(item => <option key={item.id} value={item.id}>{date(item.createdAt)} · {label(item.phase)}</option>)}</select></label></div>}
      {detail.isLoading && runId && <p role="status">Loading the saved run and evidence…</p>}
      {detail.isError && <p className={styles.error} role="alert">This run could not be refreshed. Approvals and cancellation are blocked until its current state is verified.</p>}
      {saved && <RunReview key={saved.run.id} detail={saved} busy={busy} canAct={canAct} canApprove={canApprove} canPrepareRecovery={canPrepareRecovery} onPrepareRecovery={() => void perform(prepareRecovery)} onDecide={(kind, evidence, status) => void perform(() => decide(kind, evidence, status))} onCancel={() => void perform(cancel)} />}
      {!runs.isLoading && !runs.isError && !savedRuns?.length && <p className={styles.muted}>No saved staging security runs yet. Opening this panel starts no work.</p>}
      {busy && <p role="status">Checking and saving the requested action…</p>}
      {notice && <p role="status" className={styles.notice}>{notice}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>}
  </section>;
}

function RunReview({ detail, busy, canAct, canApprove, canPrepareRecovery, onPrepareRecovery, onDecide, onCancel }: { detail: Detail; busy: boolean; canAct: boolean; canApprove: boolean; canPrepareRecovery: boolean; onPrepareRecovery: () => void; onDecide: (kind: DecisionKind, evidence: Evidence, status: 'APPROVED' | 'DENIED') => void; onCancel: () => void }) {
  const run: Run = detail.run;
  const active = !terminal.has(run.phase);
  const evidence = detail.awaitingDecision === 'CANDIDATE' ? detail.plan : detail.awaitingDecision === 'CHANGE' ? detail.proposal : null;
  return <section className={styles.card} aria-label="Saved security run">
    <header><h3>Staging security run</h3><span className={styles.status} role="status">{label(run.phase)}</span></header>
    <p className={styles.muted}>Progress is recorded by the server and worker. A waiting or blocked run is not a completed repair.</p>
    {!run.sessionBound && <p className={styles.notice}>This run belongs to a different sign-in session. You can review it here; this session cannot approve or cancel it.</p>}
    {Date.parse(run.expiresAt) <= Date.now() && <p className={styles.notice}>This run’s authority has expired. No new approval is available.</p>}
    <dl className={styles.metadata}><div><dt>Run</dt><dd className={styles.digest}>{run.id}</dd></div><div><dt>Authority expires</dt><dd>{date(run.expiresAt)}</dd></div><div><dt>Allowance / reserved / recorded cost</dt><dd>{amount(run.allowanceMicros)} / {amount(run.reservedMicros)} / {amount(run.chargedMicros)}</dd></div></dl>
    {run.errorCode && <p className={styles.notice}>Current blocker: <span className={styles.digest}>{run.errorCode}</span>. Review availability; approval cannot enable an unavailable runner.</p>}
    {detail.plan && <EvidenceReview evidence={detail.plan} title="Exact staging plan"/>}
    {detail.proposal && <EvidenceReview evidence={detail.proposal} title="Verified change proposal"/>}
    {detail.result && <EvidenceReview evidence={detail.result} title="Recorded verification result"/>}
    {evidence && detail.awaitingDecision && <DecisionReview key={`${detail.awaitingDecision}:${evidence.artifactId}:${evidence.digest}`} evidence={evidence} kind={detail.awaitingDecision} busy={busy} enabled={canAct && active} approvalEnabled={canApprove && active} onDecide={onDecide}/>}
    {detail.attempts.length > 0 && <details><summary>Recorded work and evidence ({detail.attempts.length})</summary><div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Security run evidence"><table className={styles.table}><thead><tr><th>Step</th><th>State</th><th>Evidence</th></tr></thead><tbody>{detail.attempts.map(attempt => <tr key={attempt.stepKey}><td>{label(attempt.stepKey)}</td><td>{label(attempt.state)}{attempt.errorCode && <p>{attempt.errorCode}</p>}</td><td>{attempt.artifactDigest ? <code className={styles.digest}>{attempt.artifactDigest}</code> : 'No confirmed artifact'}{attempt.completedAt && <p>{date(attempt.completedAt)}</p>}</td></tr>)}</tbody></table></div></details>}
    {detail.decisions.length > 0 && <details><summary>Saved approval decisions ({detail.decisions.length})</summary><ul>{detail.decisions.map(decision => <li key={decision.id}>{label(decision.kind)} · {label(decision.status)} · expires {date(decision.expiresAt)}<p className={styles.digest}>{decision.digest}</p></li>)}</ul></details>}
    {run.phase === 'COMPLETED' && <p className={styles.notice}>The server recorded this bounded staging workflow as completed. Review the verification evidence for its exact result and limits.</p>}
    {run.phase === 'COMPLETED' && detail.result?.change.action === 'HARDEN' && detail.result.recovery.verified && <RecoveryReview key={detail.result.digest} enabled={canPrepareRecovery} busy={busy} onPrepare={onPrepareRecovery}/>}
    {run.phase === 'OUTCOME_UNKNOWN' && <p className={styles.error} role="alert">The remote outcome is uncertain. Do not retry or restore blindly. A trusted operator must reconcile the exact target before any further change.</p>}
    {run.phase === 'CANCELLED' && <p className={styles.notice}>Cancellation is confirmed in the run journal. Completed effects have not been undone.</p>}
    {active && <div className={styles.actions}><button className={styles.danger} disabled={busy || !canAct} onClick={onCancel}>Cancel security run</button><p className={styles.muted}>Cancellation stops future work; it does not undo a completed change.</p></div>}
  </section>;
}

function EvidenceReview({ evidence, title }: { evidence: Evidence; title: string }) {
  return <section className={styles.card} aria-label={title}><h3>{title}</h3><p>{evidence.summary}</p><dl className={styles.metadata}><div><dt>Exact enrolled target</dt><dd>{evidence.change.targetLabel} · staging · revision {evidence.enrollmentRevision}</dd></div></dl><pre className={styles.diff} tabIndex={0} aria-label={`${title} permission difference`}>{`Permission only: ${evidence.change.beforeMode.toString(8).padStart(3, '0')} → ${evidence.change.afterMode.toString(8).padStart(3, '0')}\nContent: unchanged\nAction: ${evidence.change.action === 'HARDEN' ? 'remove other-user write access' : 'restore the previously approved permission'}`}</pre><dl className={styles.metadata}><div><dt>Content fingerprint</dt><dd className={styles.digest}>{evidence.change.contentDigest}</dd></div><div><dt>Exact preimage fingerprint</dt><dd className={styles.digest}>{evidence.change.preimageDigest}</dd></div><div><dt>Recovery</dt><dd>Encrypted · {evidence.recovery.verified ? 'verified' : 'verification pending; no write approved'}</dd><dd className={styles.digest}>{evidence.recovery.digest}</dd></div><div><dt>Immutable approval fingerprint</dt><dd className={styles.digest}>{evidence.digest}</dd></div></dl>{evidence.checks.length > 0 && <ul>{evidence.checks.map(check => <li key={check.name}>{check.passed ? 'Passed' : 'Not passed'} · {check.name}</li>)}</ul>}<p className={styles.muted}>Restoring a permission is a separate operation requiring fresh authority. This approval never includes automatic restoration or a production release.</p></section>;
}

function RecoveryReview({ enabled, busy, onPrepare }: { enabled: boolean; busy: boolean; onPrepare: () => void }) {
  const [consent, setConsent] = useState(false);
  return <section className={styles.card} aria-label="Separate staging restoration"><h3>Prepare a separate restoration</h3><p>This creates a new plan for this completed run’s exact enrolled target and retained recovery evidence. The server rechecks your current authority and rejects a changed target or uncertain outcome.</p><label className={styles.consent}><input type="checkbox" checked={consent} disabled={busy || !enabled} onChange={event => setConsent(event.target.checked)}/><span>I authorize a new read-only restoration plan for this exact completed staging run. No file change is approved by this action.</span></label><div className={styles.actions}><button className={styles.secondary} disabled={busy || !enabled || !consent} onClick={() => { setConsent(false); onPrepare(); }}>Prepare separate restoration plan</button></div></section>;
}

function DecisionReview({ evidence, kind, busy, enabled, approvalEnabled, onDecide }: { evidence: Evidence; kind: DecisionKind; busy: boolean; enabled: boolean; approvalEnabled: boolean; onDecide: (kind: DecisionKind, evidence: Evidence, status: 'APPROVED' | 'DENIED') => void }) {
  const [consent, setConsent] = useState(false);
  const canApprove = enabled && approvalEnabled && (kind === 'CANDIDATE' || evidence.recovery.verified && evidence.checks.every(check => check.passed));
  return <section className={styles.card} aria-label={kind === 'CANDIDATE' ? 'Candidate work approval' : 'Staging change approval'}><h3>{kind === 'CANDIDATE' ? 'Approve candidate work' : evidence.change.action === 'RESTORE' ? 'Approve the exact staging restoration' : 'Approve the exact staging change'}</h3><label className={styles.consent}><input type="checkbox" checked={consent} disabled={busy || !canApprove} onChange={event => setConsent(event.target.checked)}/><span>{kind === 'CANDIDATE' ? 'I reviewed this exact plan and authorize its bounded snapshot, candidate preparation and verification. I am not approving a file change.' : evidence.change.action === 'RESTORE' ? 'I reviewed the exact restoration difference, preimage and verified recovery evidence. I authorize only this staging file permission restoration. Production changes and other files are excluded.' : 'I reviewed the exact permission difference, preimage and verified recovery evidence. I authorize only this staging file permission change. Production changes and restoration are excluded.'}</span></label><div className={styles.actions}><button className={styles.primary} disabled={busy || !canApprove || !consent} onClick={() => { setConsent(false); onDecide(kind, evidence, 'APPROVED'); }}>{kind === 'CANDIDATE' ? 'Approve candidate work only' : evidence.change.action === 'RESTORE' ? 'Approve exact staging restoration' : 'Approve exact staging change'}</button><button className={styles.secondary} disabled={busy || !enabled} onClick={() => { setConsent(false); onDecide(kind, evidence, 'DENIED'); }}>Decline this {kind === 'CANDIDATE' ? 'plan' : 'change'}</button></div></section>;
}
