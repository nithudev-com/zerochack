'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

type Revision = { id: string; version: number; sourceDigest: string; createdAt: string };
type Workspace = { job: { id: string; state: string }; revision: Revision; files: Array<{ path: string; content: string }>; history: Revision[]; checks: Array<{ id: string; filename: string; createdAt: string }> };
export function CreateCareWorkspace({ jobId, websiteId, revisionId, sourceDigest }: { jobId: string; websiteId: string; revisionId: string; sourceDigest: string }) {
  const client = useQueryClient(); const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [requestKey, setRequestKey] = useState<string>();
  async function create() {
    const key = requestKey ?? crypto.randomUUID(); setRequestKey(key); setBusy(true); setMessage('');
    try {
      await api(`/jobs/${jobId}/workspaces`, { method: 'POST', body: JSON.stringify({ requestKey: key, revisionId, sourceDigest, authorizeTextWorkspace: true }) });
      setMessage('Text workspace saved in this website’s staging history. Open it below to make changes.'); setConsent(false); setRequestKey(undefined);
      await client.invalidateQueries({ queryKey: ['care', websiteId] });
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Workspace creation failed.'); }
    finally { setBusy(false); }
  }
  return <details className="care-panel"><summary>Create a text workspace</summary><p>Copy these selected files into a private staging workspace. Edit text, save versions and run fixed static checks. Source code is never executed and this does not approve a release.</p><label className="care-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)}/>I authorize copying this exact source selection into a text workspace.</label><button disabled={busy || !consent} onClick={() => void create()}>{busy ? 'Saving…' : 'Create text workspace'}</button>{message && <p role="status">{message}</p>}</details>;
}

export function CareWorkspace({ jobId, websiteId }: { jobId: string; websiteId: string }) {
  const client = useQueryClient(); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState('');
  const [path, setPath] = useState(''); const [before, setBefore] = useState(''); const [after, setAfter] = useState(''); const [consent, setConsent] = useState(false);
  const [patchKey, setPatchKey] = useState<string>(); const [checkKeys, setCheckKeys] = useState<Record<string, string>>({});
  const query = useQuery({ queryKey: ['care-workspace', websiteId, jobId], queryFn: () => api<Workspace>(`/workspaces/${jobId}`), enabled: open, retry: false });
  const data = query.data; const editable = data?.job.state === 'WAITING_FOR_INPUT';
  useEffect(() => { setConsent(false); setPatchKey(undefined); }, [data?.revision.sourceDigest]);
  const selected = data?.files.find((file) => file.path === path);
  const changed = () => { setConsent(false); setPatchKey(undefined); setError(''); };
  async function action(kind: 'patch' | 'T33' | 'T34' | 'close') {
    if (!data) return; setBusy(true); setError(''); setResult('');
    const checkKey = `${kind}-${data.revision.version}`;
    const key = kind === 'patch' ? patchKey ?? crypto.randomUUID() : checkKeys[checkKey] ?? crypto.randomUUID();
    if (kind === 'patch') setPatchKey(key); else setCheckKeys({ ...checkKeys, [checkKey]: key });
    try {
      const response = await api(kind === 'close' ? `/jobs/${jobId}/cancel` : `/workspaces/${jobId}/${kind === 'patch' ? 'patches' : `checks/${kind}`}`, { method: 'POST', ...(kind === 'close' ? {} : { body: JSON.stringify({ requestKey: key, version: data.revision.version, sourceDigest: data.revision.sourceDigest, ...(kind === 'patch' ? { patches: [{ path, before, after }], authorizeTextPatch: true } : {}) }) }) });
      if (kind === 'patch') { setBefore(''); setAfter(''); setConsent(false); setPatchKey(undefined); } else if (kind !== 'close') setResult(JSON.stringify(response, null, 2));
      await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: ['care', websiteId] })]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The workspace action failed.'); }
    finally { setBusy(false); }
  }
  async function readSaved(id: string) {
    setBusy(true); setError('');
    try { setResult(JSON.stringify(await api(`/workspaces/${jobId}/check-results/${id}`), null, 2)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The saved check is unavailable.'); }
    finally { setBusy(false); }
  }
  async function download(version: number) {
    setBusy(true); setError('');
    try {
      const value = await api(`/workspaces/${jobId}/versions/${version}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `workspace-v${version}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Download failed.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Text workspace"><button aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide text workspace' : 'Open text workspace'}</button>
    {open && <div className="care-panel">
      <p>Saved text versions remain available when you close this page. Static checks do not run your application or approve deployment.</p>
      {query.isLoading && <p role="status">Loading saved workspace…</p>}
      {(error || query.error) && <p role="alert" className="care-alert">{error || query.error?.message}</p>}
      {data && <><h4>Saved version {data.revision.version} · {editable ? 'Open for text edits' : 'Closed; history retained'}</h4>
        <button disabled={busy} onClick={() => void query.refetch()}>Reload current version</button>
        <label>Workspace file<select value={path} disabled={busy} onChange={(event) => { setPath(event.target.value); setBefore(''); setAfter(''); changed(); }}><option value="">Choose a file</option>{data.files.map((file) => <option key={file.path}>{file.path}</option>)}</select></label>
        {selected && <details><summary>Current file contents</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>{selected.content}</pre></details>}
        {editable && <><form className="care-issue-form" onSubmit={(event) => { event.preventDefault(); void action('patch'); }}><label>Original text to replace<textarea required disabled={busy} maxLength={25000} value={before} onChange={(event) => { setBefore(event.target.value); changed(); }}/></label><label>Replacement text<textarea disabled={busy} maxLength={25000} value={after} onChange={(event) => { setAfter(event.target.value); changed(); }}/></label><p>The original text must occur exactly once. A changed source version requires reloading and reviewing your edit.</p><label className="care-consent"><input type="checkbox" disabled={busy} checked={consent} onChange={(event) => setConsent(event.target.checked)}/>I reviewed this exact text change and authorize saving a new version.</label><button disabled={busy || !selected || !before || !consent}>Save text version</button></form>
          <div className="care-inline-actions"><button disabled={busy} onClick={() => void action('T33')}>Run fixed lint</button><button disabled={busy} onClick={() => void action('T34')}>Run snapshot type check</button><button disabled={busy} onClick={() => void action('close')}>Close workspace and keep history</button></div></>}
        <details><summary>Saved versions · {data.history.length}</summary><ul>{data.history.map((revision) => <li key={revision.id}>Version {revision.version} <button disabled={busy} onClick={() => void download(revision.version)}>Download version {revision.version}</button></li>)}</ul></details>
        <details><summary>Saved static checks · {data.checks.length}</summary><ul>{data.checks.map((check) => <li key={check.id}><button disabled={busy} onClick={() => void readSaved(check.id)}>{check.filename.slice(0, 3)} · {new Date(check.createdAt).toLocaleString()}</button></li>)}</ul></details>
        {result && <details open><summary>Static result and limitations</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{result}</pre></details>}
      </>}
    </div>}
  </section>;
}
