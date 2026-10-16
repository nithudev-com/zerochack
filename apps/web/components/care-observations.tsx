'use client';
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
type Coordinate = { ecosystem: 'npm' | 'Packagist'; name: string; version: string; evidence: string; path: string };
type Options = { target: string | null; environment: string; networkAvailable: boolean; advisoriesAvailable: boolean; revisionId: string | null; sourceDigest: string | null; inventory: { entries: Coordinate[]; skipped: number; truncated: boolean; limitation: string } | null; history: Array<{ id: string; toolId: string; state: string; createdAt: string }>; nextCursor: string | null };
const key = (p: Coordinate) => `${p.ecosystem}:${p.name}@${p.version}`;
export function CareObservations({ jobId, websiteId }: { jobId: string; websiteId: string }) {
  const observationId = useId();
  const client = useQueryClient(); const [opened, setOpened] = useState(false);
  const [before, setBefore] = useState<string | null>(null);
  const options = useQuery({ queryKey: ['care-observations', jobId, before], queryFn: () => api<Options>(`/jobs/${jobId}/observation-options${before ? `?before=${before}` : ''}`), enabled: opened, staleTime: 0 });
  const [tool, setTool] = useState<'T20' | 'T23' | 'T24'>('T23');
  const [selection, setSelection] = useState<string[]>([]); const [approval, setApproval] = useState<string | null>(null);
  const binding = JSON.stringify([jobId, tool, options.data?.target, options.data?.environment, options.data?.revisionId, options.data?.sourceDigest, options.data?.networkAvailable, options.data?.advisoriesAvailable, [...selection].sort()]);
  const consent = approval !== null && approval === binding;
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [result, setResult] = useState(''); const [error, setError] = useState('');
  function reset() { setRequestKey(null); setApproval(null); setResult(''); setError(''); }
  async function read(id: string) {
    const value = await api(`/jobs/${jobId}/observations/${id}`); setResult(JSON.stringify(value, null, 2));
  }
  async function run() {
    const value = options.data; if (!value || !consent || busy) return;
    setBusy(true); setError(''); setResult('');
    const id = requestKey ?? crypto.randomUUID(); setRequestKey(id);
    try {
      const packages = value.inventory?.entries.filter((p) => selection.includes(key(p))).map(({ ecosystem, name, version }) => ({ ecosystem, name, version })) ?? [];
      const response = await api<{ runId: string; state: string }>(`/jobs/${jobId}/observations`, { method: 'POST', body: JSON.stringify(tool === 'T20' ? { requestKey: id, toolId: tool, revisionId: value.revisionId, sourceDigest: value.sourceDigest, packages, consentToSharePackageVersions: true } : { requestKey: id, toolId: tool, confirmTarget: value.target, authorizeReadOnlyObservation: true }) });
      await read(response.runId); setApproval(null); setRequestKey(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The observation did not complete.'); }
    finally { setBusy(false); await client.invalidateQueries({ queryKey: ['care-observations', jobId] }); await client.invalidateQueries({ queryKey: ['care', websiteId] }); }
  }
  const data = options.data; const selectedAvailable = tool === 'T20' ? data?.advisoriesAvailable && selection.length > 0 && selection.length <= 50 && selection.every((id) => data.inventory?.entries.some((p) => key(p) === id)) : data?.networkAvailable && (tool !== 'T24' || data.target?.startsWith('https:'));
  return <details className="care-panel" onToggle={(event) => setOpened(event.currentTarget.open)}><summary>Authorized website observations & advisory matching</summary>
    <p>These are separate, manually approved observations—not an autonomous scan or repair. Results are retained with their scope and limitations.</p>
    {options.isError && <p role="alert">Observation options are unavailable. Existing saved evidence remains unchanged.</p>}
    {options.isLoading && <p role="status">Loading authorized observation options…</p>}
    {data && <><form aria-label="Approved observations" className="care-issue-form" onSubmit={(event) => { event.preventDefault(); void run(); }}>
      <label htmlFor={observationId}>Observation</label><select id={observationId} disabled={busy} value={tool} onChange={(event) => { setTool(event.target.value as typeof tool); reset(); }}><option value="T23">Website root HTTP headers</option><option value="T24">Website TLS certificate</option><option value="T20">OSV dependency advisory matches</option></select>
      {tool === 'T20' ? <><p>Only the package names, exact versions and ecosystems you select will be sent to OSV. Private package names may identify your project. No source, credentials or website URLs are shared.</p>
        {!data.advisoriesAvailable && <p>Requires an enabled advisory adapter and a current exact source-review approval.</p>}
        <fieldset disabled={busy || !data.advisoriesAvailable}><legend>Select up to 50 exact package versions</legend><div style={{ maxHeight: 260, overflow: 'auto' }}>{data.inventory?.entries.map((p) => <label className="care-consent" key={key(p)}><input type="checkbox" checked={selection.includes(key(p))} disabled={!selection.includes(key(p)) && selection.length >= 50} onChange={(event) => { const checked = event.target.checked; setSelection((old) => checked ? [...old, key(p)] : old.filter((id) => id !== key(p))); reset(); }}/>{p.name} {p.version} ({p.ecosystem}; {p.evidence.toLowerCase()})</label>)}</div></fieldset>
        {data.inventory && <p>{data.inventory.limitation} Skipped: {data.inventory.skipped}.{data.inventory.truncated ? ' Inventory is incomplete.' : ''}</p>}
      </> : <><p>Target: <strong>{data.target ?? 'Unavailable'}</strong> · {data.environment}</p><p>No credentials, cookies, request bodies, redirects, or additional paths are used. HTTP performs one HEAD request; TLS performs one certificate-validated handshake.</p>{!data.networkAvailable && <p>Requires the enabled observation service and the verified production website binding.</p>}</>}
      <label className="care-consent"><input type="checkbox" disabled={busy || !selectedAvailable} checked={consent} onChange={(event) => { setApproval(event.target.checked ? binding : null); setRequestKey(null); }}/>{tool === 'T20' ? 'I approve sharing only these selected package versions with OSV for this lookup.' : 'I am authorized for this website and approve this single read-only observation of the displayed target.'}</label>
      <button disabled={busy || !consent || !selectedAvailable}>{busy ? 'Running approved observation…' : 'Run this observation'}</button>
    </form><h4>Retained observation history</h4>{!data.history.length && <p>No observations have been recorded for this job.</p>}{data.history.map((item) => <p key={item.id}><button disabled={busy} onClick={() => { void read(item.id).catch(() => setError('This saved observation is unavailable.')); }}>{item.toolId} · {item.state} · {new Date(item.createdAt).toLocaleString()}</button></p>)}<div>{before && <button onClick={() => setBefore(null)}>Latest observations</button>}{data.nextCursor && <button onClick={() => setBefore(data.nextCursor)}>Older observations</button>}</div></>}
    {error && <p role="alert" className="care-alert">{error}</p>}{result && <details open><summary>Recorded result and limitations</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{result}</pre></details>}
  </details>;
}
