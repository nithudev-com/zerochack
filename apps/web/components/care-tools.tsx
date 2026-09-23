'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

const evidenceTools = [
  ['T03','Available access types'], ['T05','Saved findings and citations'], ['T51','Candidate change summary'],
  ['T56','Recorded release status'], ['T57','Recorded workflow errors'], ['T58','Recorded monitoring health'], ['T62','Saved review summary']
] as const;
export function CareTools({ jobId, websiteId, environment, review }: { jobId: string; websiteId: string; environment: string; review: boolean }) {
  const client = useQueryClient();
  const [tool, setTool] = useState('T62'); const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [baseline, setBaseline] = useState(''); const [candidate, setCandidate] = useState('');
  const [interval, setInterval] = useState(60); const [consent, setConsent] = useState(false);
  const [proposalKey, setProposalKey] = useState<string | null>(null);
  async function run(proposal = false) {
    setBusy(true); setError(''); setResult('');
    const key = proposalKey ?? crypto.randomUUID();
    if (proposal) setProposalKey(key);
    try {
      const response = await api(proposal ? `/jobs/${jobId}/monitoring-plan` : `/jobs/${jobId}/tools/${tool}`, { method: 'POST', body: JSON.stringify(proposal ? { requestKey: key, intervalMinutes: interval, alertCooldownMinutes: interval, expectedStatus: 200 } : tool === 'T30' ? { baselinePath: baseline, candidatePath: candidate } : {}) });
      setResult(JSON.stringify(response, null, 2));
      if (proposal) { setProposalKey(null); setConsent(false); await client.invalidateQueries({ queryKey: ['care', websiteId] }); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The request could not complete.'); }
    finally { setBusy(false); }
  }
  return <details className="care-panel"><summary>Saved evidence & source tools</summary><p>Read this job’s saved evidence. Source comparisons require a current source-review approval. These tools do not contact your website.</p>
    <form className="care-issue-form" onSubmit={(event) => { event.preventDefault(); void run(); }}><label>Evidence to read<select value={tool} onChange={(event) => { setTool(event.target.value); setResult(''); setError(''); }}>{evidenceTools.map(([id, title]) => <option key={id} value={id}>{title}</option>)}{review && <option value="T30">Compare approved CSS token declarations</option>}</select></label>
      {tool === 'T30' && <><label>Baseline CSS path<input required maxLength={180} value={baseline} onChange={(event) => setBaseline(event.target.value)}/></label><label>Candidate CSS path<input required maxLength={180} value={candidate} onChange={(event) => setCandidate(event.target.value)}/></label></>}
      <button disabled={busy}>{busy ? 'Reading…' : 'Read evidence'}</button>
    </form>
    {environment === 'PRODUCTION' && <form className="care-issue-form" onSubmit={(event) => { event.preventDefault(); void run(true); }}><h4>Propose a monitoring schedule</h4><p>The proposal is saved in your history. Customer review and operator setup are still required before checks run.</p><label>Check and alert cooldown interval (minutes)<input type="number" required min={5} max={10080} value={interval} onChange={(event) => { setInterval(Number(event.target.value)); setProposalKey(null); setConsent(false); }}/></label><label className="care-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)}/>Save this proposal for review; do not activate monitoring.</label><button disabled={busy || !consent}>Save monitoring proposal</button></form>}
    {error && <p role="alert" className="care-alert">{error}</p>}{result && <details open><summary>Result and limitations</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{result}</pre></details>}
  </details>;
}
