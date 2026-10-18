'use client';
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { verificationProfiles } from '@zerochack/care/verification-profiles';
import { api } from '../lib/api';

type Source = { artifactId: string; sourceDigest: string; label: string; revisionId?: string };
type Run = { id: string; toolId: string; state: string; errorCode: string | null; createdAt: string };
type Options = { sources: Source[]; baselines: Source[]; enabled: boolean; policy: string; imageDigest: string | null; history: Run[]; nextCursor: string | null };
type Result = { id: string; state: string; errorCode: string | null; result: { outcome: string; checks: Array<{ name: string; passed: boolean }>; limitations: string[]; candidateFiles?: Array<{ path: string; content: string }> } | null };
export function CareVerificationTools({ jobId, websiteId }: { jobId: string; websiteId: string }) {
  const field = useId(); const client = useQueryClient(); const [open, setOpen] = useState(false); const [cursor, setCursor] = useState<string | null>(null);
  const options = useQuery({ queryKey: ['care-verification', jobId, cursor], queryFn: () => api<Options>(`/jobs/${jobId}/verification-options${cursor ? `?before=${cursor}` : ''}`), enabled: open, staleTime: 0 });
  const [toolId, setTool] = useState('T35'); const [sourceId, setSource] = useState(''); const [baselineId, setBaseline] = useState('');
  const [approval, setApproval] = useState<string | null>(null); const [requestKey, setRequestKey] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<Result | null>(null);
  const profile = verificationProfiles.find((item) => item.id === toolId)!;
  const source = options.data?.sources.find((item) => item.artifactId === sourceId); const baseline = toolId === 'T40' ? options.data?.baselines.find((item) => item.artifactId === baselineId) : undefined;
  const binding = JSON.stringify([jobId, toolId, source, baseline, options.data?.policy, options.data?.imageDigest, options.data?.enabled]);
  const consent = approval !== null && approval === binding; const ready = options.data?.enabled && source && (toolId !== 'T40' || baseline);
  const changed = () => { setApproval(null); setRequestKey(null); setError(''); setResult(null); };
  async function read(id: string) { setResult(await api<Result>(`/jobs/${jobId}/verification-runs/${id}`)); }
  async function run() {
    if (!ready || !consent || busy || !source) return;
    setBusy(true); setError(''); setResult(null); const key = requestKey ?? crypto.randomUUID(); setRequestKey(key);
    try {
      const response = await api<{ runId: string }>(`/jobs/${jobId}/verification-runs`, { method: 'POST', body: JSON.stringify({ toolId, requestKey: key, revisionId: source.revisionId, artifactId: source.artifactId, sourceDigest: source.sourceDigest, ...(baseline ? { baselineArtifactId: baseline.artifactId, baselineDigest: baseline.sourceDigest } : {}), imageDigest: options.data!.imageDigest, authorizeVerification: true, syntheticDataOnly: true }) });
      await read(response.runId); setApproval(null); setRequestKey(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The verification could not complete.'); }
    finally { setBusy(false); await client.invalidateQueries({ queryKey: ['care-verification', jobId] }); await client.invalidateQueries({ queryKey: ['care', websiteId] }); }
  }
  function download() {
    if (!result?.result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.result, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `verification-${result.id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details className="care-panel" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Isolated verification tools · 11 profiles</summary>
    <p>Check a saved source version using the supported offline fixtures. Execution requires a configured isolated service. Your results remain available after closing this page. These checks do not certify live websites or external providers.</p>
    {options.isLoading && <p role="status">Loading verification history…</p>}{options.isError && <p role="alert">Verification history could not load. Close and reopen this panel to retry.</p>}
    {options.data && <><form aria-label="Isolated source verification" className="care-issue-form" onSubmit={(event) => { event.preventDefault(); void run(); }}>
      {!options.data.enabled && <p>New runs need an enabled isolated service and a current source in an active staging review or workspace.</p>}
      <label htmlFor={`${field}-tool`}>Verification profile</label><select id={`${field}-tool`} value={toolId} disabled={busy} onChange={(event) => { setTool(event.target.value); changed(); }}>{verificationProfiles.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.name}</option>)}</select>
      <p>{profile.boundary}</p><p>Required source files: <code>{profile.file}</code></p>
      <label htmlFor={`${field}-source`}>Saved source version</label><select id={`${field}-source`} value={sourceId} disabled={busy} onChange={(event) => { setSource(event.target.value); changed(); }}><option value="">Choose the current saved version</option>{options.data.sources.map((item) => <option key={item.artifactId} value={item.artifactId}>{item.label}</option>)}</select>
      {toolId === 'T40' && <><label htmlFor={`${field}-baseline`}>Saved baseline version</label><select id={`${field}-baseline`} value={baselineId} disabled={busy} onChange={(event) => { setBaseline(event.target.value); changed(); }}><option value="">Choose an earlier source snapshot</option>{options.data.baselines.map((item) => <option key={item.artifactId} value={item.artifactId}>{item.label}</option>)}</select></>}
      <label className="care-consent"><input type="checkbox" checked={consent} disabled={busy || !ready} onChange={(event) => { setApproval(event.target.checked ? binding : null); setRequestKey(null); }}/>I authorize this exact saved-source check with synthetic data only, understand its stated scope, and approve retaining its result.</label>
      <button disabled={busy || !ready || !consent}>{busy ? 'Running isolated verification…' : 'Run approved verification'}</button>
    </form><h4>Retained verification history</h4>{!options.data.history.length && <p>No verification runs have been recorded.</p>}{options.data.history.map((item) => <p key={item.id}><button disabled={busy} onClick={() => { void read(item.id).catch(() => setError('The saved verification result is unavailable.')); }}>{item.toolId} · {item.state} · {new Date(item.createdAt).toLocaleString()}</button>{item.errorCode && <span> · {item.errorCode}</span>}</p>)}{cursor && <button onClick={() => setCursor(null)}>Latest verification runs</button>}{options.data.nextCursor && <button onClick={() => setCursor(options.data!.nextCursor)}>Older verification runs</button>}</>}
    {error && <p role="alert">{error}</p>}{result && <section aria-label="Saved verification evidence"><p>Run: {result.state}{result.errorCode ? ` · ${result.errorCode}` : ''}</p>{result.result && <><p><strong>Result: {result.result.outcome}</strong></p><ul>{result.result.checks.map((item, index) => <li key={index}>{item.passed ? 'Passed' : 'Failed'} · {item.name}</li>)}</ul><ul>{result.result.limitations.map((item) => <li key={item}>{item}</li>)}</ul><button onClick={download}>Download retained verification result</button>{result.result.candidateFiles && <p>The downloaded report includes the prepared source-file candidate. It has not been installed.</p>}<details><summary>Evidence details</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{JSON.stringify(result.result, null, 2)}</pre></details></>}</section>}
  </details>;
}
