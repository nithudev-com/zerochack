'use client';

import { useState } from 'react';

import { technologyCoverage as technologies, technologyGroups as groups, technologyChecks } from '@zerochack/care/technology-coverage';

export function HomeTechnologies({ roles, implementedTools, plannedTools }: { roles: Array<{ id: string; name: string }>; implementedTools: number; plannedTools: number }) {
  const [group, setGroup] = useState<string>(groups[0]);
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const filtered = technologies.filter(item => (group === groups[0] || item.group === group) && `${item.title} ${item.description} ${item.tags.join(' ')} ${item.examples.join(' ')}`.toLowerCase().includes(normalized));
  return <div className="zr-tech-directory">
    <p className="zr-tech-availability"><strong>{roles.length} source-review roles · {implementedTools} implemented tools</strong><span>{plannedTools} planned tools remain unavailable. AI review needs a configured provider; your website workspace shows enabled features.</span></p>
    <div className="zr-tech-toolbar"><div className="zr-tech-filters" aria-label="Filter technology areas">{groups.map(item => <button type="button" key={item} aria-pressed={group === item} onClick={() => setGroup(item)}>{item}</button>)}</div><label className="zr-tech-search"><span className="sr-only">Search technologies or issues</span><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Try Docker, API, WordPress…"/></label></div>
    <p className="zr-tech-result-count" role="status">{filtered.length} of {technologies.length} technology areas{query ? ` matching “${query}”` : ''}</p>
    <div className="zr-tech-directory-grid">{filtered.map(item => <article key={item.title}><div className="zr-tech-card-title"><span aria-hidden="true">{item.symbol}</span><h3>{item.title}</h3></div><p>{item.description}</p><ul>{item.tags.map(tag => <li key={tag}>{tag}</li>)}</ul><details className="zr-tech-support"><summary>Review team & file support</summary><p><strong>Suggested team:</strong> {item.roleIds.map(id => roles.find(role => role.id === id)?.name).filter(Boolean).join(', ')}.</p><p><strong>Example files:</strong> {item.examples.join(', ')}.</p><p><strong>Automatic checks on matching files:</strong> {item.checkIds.length ? item.checkIds.map(id => technologyChecks[id]).join('; ') : 'No format-specific parser for these examples; source review only'}. All uploads receive pattern-based secret screening.</p><p>File acceptance does not verify platform behavior. Open your website’s Care workspace and choose this technology area in a source review.</p></details></article>)}</div>
    {filtered.length === 0 && <div className="zr-tech-empty"><h3>No matching area in this view.</h3><p>Try a technology name, a related issue, or browse all areas. Your team can assess the scope of an unlisted stack.</p><button type="button" onClick={() => { setQuery(''); setGroup(groups[0]); }}>Show all technology areas</button></div>}
    <div className="zr-tech-scope"><span aria-hidden="true">↳</span><p><strong>Your technology doesn’t need to fit in one box.</strong> Share the project context and relevant source or redacted configuration in a supported text format. Coverage depends on the evidence provided. These are review areas, not a claim of certified integrations, live diagnostics or automatic fixes for every platform.</p></div>
  </div>;
}
