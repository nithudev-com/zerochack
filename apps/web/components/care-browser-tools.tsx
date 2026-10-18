'use client';
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

type Source = { revisionId: string; artifactId: string; sourceDigest: string; label: string; path?: string };
type Options = { enabled: boolean; policy: string; sources: Source[]; history: Array<{ id: string; toolId: string; state: string; errorCode: string | null; createdAt: string }>; nextCursor: string | null };
type Result = { state: string; errorCode: string | null; result: unknown; screenshot: string | null; screenshotArtifactId: string | null };
const tools = { T25: 'Render saved HTML', T26: 'Accessibility snapshot', T27: 'Masked screenshot', T28: 'Static document journey' };
export function CareBrowserTools({ jobId, websiteId }: { jobId: string; websiteId: string }) {
  const field = useId(); const client = useQueryClient(); const [opened, setOpened] = useState(false); const [before, setBefore] = useState<string | null>(null);
  const options = useQuery({ queryKey: ['care-browser', jobId, before], queryFn: () => api<Options>(`/jobs/${jobId}/browser-options${before ? `?before=${before}` : ''}`), enabled: opened, staleTime: 0 });
  const [selection, setSelection] = useState(''); const [tool, setTool] = useState<keyof typeof tools>('T25'); const [viewport, setViewport] = useState('DESKTOP'); const [privateText, setPrivateText] = useState('');
  const [approval, setApproval] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<Result | null>(null); const [requestKey, setRequestKey] = useState<string | null>(null);
  const sourceKey = (source: Source) => `${source.artifactId}:${source.path ?? ''}`;
  const source = options.data?.sources.find((item) => sourceKey(item) === selection);
  const privateIds = privateText.split(/[\s,]+/).filter(Boolean).sort();
  const validIds = privateIds.length <= 20 && new Set(privateIds).size === privateIds.length && privateIds.every((id) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id));
  const binding = JSON.stringify([jobId, source, tool, viewport, privateIds, options.data?.enabled, options.data?.policy]);
  const consent = approval !== null && approval === binding;
  function reset() { setApproval(null); setRequestKey(null); setError(''); setResult(null); }
  async function read(id: string) { setResult(await api<Result>(`/jobs/${jobId}/browser-runs/${id}`)); }
  async function run() {
    if (!source || !consent || !validIds || !options.data?.enabled || busy) return;
    setBusy(true); setError(''); setResult(null); const key = requestKey ?? crypto.randomUUID(); setRequestKey(key);
    try {
      const selected = { revisionId: source.revisionId, artifactId: source.artifactId, sourceDigest: source.sourceDigest, ...(source.path ? { path: source.path } : {}) };
      const response = await api<{ runId: string }>(`/jobs/${jobId}/browser-runs`, { method: 'POST', body: JSON.stringify({ ...selected, requestKey: key, toolId: tool, viewport, privateIds, privacyReviewed: true, authorizeStaticBrowser: true }) });
      await read(response.runId); setApproval(null); setRequestKey(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The browser check could not complete.'); }
    finally { setBusy(false); await client.invalidateQueries({ queryKey: ['care-browser', jobId] }); await client.invalidateQueries({ queryKey: ['care', websiteId] }); }
  }
  return <details className="care-panel" onToggle={(event) => setOpened(event.currentTarget.open)}><summary>Offline HTML browser tools</summary>
    <p>Render a saved standalone HTML page. Results are retained across visits. The static document journey checks page structure, viewport overflow and the first visible disclosure control. It does not test a complete application.</p>
    {options.isLoading && <p role="status">Loading saved HTML choices…</p>}{options.isError && <p role="alert">Browser history is unavailable. Try opening this panel again.</p>}
    {options.data && <><form aria-label="Offline browser check" className="care-issue-form" onSubmit={(event) => { event.preventDefault(); void run(); }}>
      {!options.data.enabled && <p>New runs require an enabled, sandbox-ready browser service and an eligible HTML source in an active staging job.</p>}
      <label htmlFor={`${field}-source`}>Saved HTML version</label><select id={`${field}-source`} disabled={busy} value={selection} onChange={(event) => { setSelection(event.target.value); reset(); }}><option value="">Choose a saved page</option>{options.data.sources.map((item) => <option key={sourceKey(item)} value={sourceKey(item)}>{item.label}</option>)}</select>
      <label htmlFor={`${field}-tool`}>Browser check</label><select id={`${field}-tool`} disabled={busy} value={tool} onChange={(event) => { setTool(event.target.value as keyof typeof tools); reset(); }}>{Object.entries(tools).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <label htmlFor={`${field}-viewport`}>Viewport</label><select id={`${field}-viewport`} disabled={busy} value={viewport} onChange={(event) => { setViewport(event.target.value); reset(); }}><option value="MOBILE">Mobile · 390 × 844</option><option value="TABLET">Tablet · 768 × 1024</option><option value="DESKTOP">Desktop · 1280 × 900</option></select>
      <label htmlFor={`${field}-private`}>Private region HTML IDs (optional)</label><input id={`${field}-private`} disabled={busy} maxLength={1300} value={privateText} placeholder="customer-details account-summary" onChange={(event) => { setPrivateText(event.target.value); reset(); }}/>
      <p>Enter up to 20 unique element IDs, separated by spaces. Selected content is removed from the accessibility snapshot and blacked out in screenshots. Review the rest of the page for private information before saving evidence.</p>
      {!validIds && <p role="alert">Use up to 20 distinct simple IDs beginning with a letter.</p>}
      <label className="care-consent"><input type="checkbox" checked={consent} disabled={busy || !source || !validIds || !options.data.enabled} onChange={(event) => { setApproval(event.target.checked ? binding : null); setRequestKey(null); }}/>I reviewed this page for private information and authorize this check of the selected saved version, viewport and private regions.</label>
      <button disabled={busy || !consent || !source || !validIds || !options.data.enabled}>{busy ? 'Running browser check…' : 'Run approved browser check'}</button>
    </form><h4>Retained browser history</h4>{!options.data.history.length && <p>No browser runs have been recorded.</p>}{options.data.history.map((run) => <p key={run.id}><button disabled={busy} onClick={() => { void read(run.id).catch(() => setError('The saved browser result is unavailable.')); }}>{tools[run.toolId as keyof typeof tools] ?? run.toolId} · {run.state} · {new Date(run.createdAt).toLocaleString()}</button>{run.errorCode && <span> · {run.errorCode}</span>}</p>)}{before && <button onClick={() => setBefore(null)}>Latest browser runs</button>}{options.data.nextCursor && <button onClick={() => setBefore(options.data!.nextCursor)}>Older browser runs</button>}</>}
    {error && <p role="alert" className="care-alert">{error}</p>}{result && <section aria-label="Saved browser evidence"><p>{result.state}{result.errorCode ? ` · ${result.errorCode}` : ''}</p>{result.screenshot && <figure><img src={result.screenshot} alt="Retained screenshot of the selected HTML page with approved private regions masked" style={{ maxWidth: '100%', height: 'auto' }}/><figcaption>Screenshot artifact: {result.screenshotArtifactId}</figcaption></figure>}<pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{JSON.stringify(result.result, null, 2)}</pre></section>}
  </details>;
}
