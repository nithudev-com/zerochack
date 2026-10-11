'use client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button, Card } from '@zerochack/ui';
import { websiteNavigationLabels } from '@zerochack/types';
import styles from './websites.module.css';

export type WebsiteListItem = { id: string; name: string; url: string; connectionSummary?: { kind: 'NONE' | 'SSH' | 'CONNECTOR'; providers: string[]; lastCheckedAt: string | null } };
export const websiteTools = ([
  { id: 'seo', symbol: '↗', description: 'Search visibility and website optimization.' },
  { id: 'security', symbol: '◇', description: 'Website protection and security checks.' },
  { id: 'automation', symbol: 'ϟ', description: 'Repeatable workflows and routine tasks.' },
  { id: 'marketing', symbol: '◎', description: 'Campaigns and audience growth.' },
  { id: 'chat', symbol: '✦', description: 'A conversational assistant for your website.' }
] as const).map(item => ({ ...item, name: websiteNavigationLabels.TOOLS[item.id] }));
const providerNames: Record<string, string> = { wordpress: 'WordPress', shopify: 'Shopify', joomla: 'Joomla', woocommerce: 'WooCommerce', contentful: 'Contentful', datocms: 'DatoCMS', webflow: 'Webflow' };
const providerName = (provider: string) => providerNames[provider] ?? provider.replaceAll('_', ' ').replace(/^./u, char => char.toUpperCase());

export function WebsiteConnection({ website }: { website: WebsiteListItem }) {
  const summary = website.connectionSummary;
  const checked = Boolean(summary?.lastCheckedAt && Number.isFinite(Date.parse(summary.lastCheckedAt)));
  const ssh = checked && summary?.kind === 'SSH';
  const other = checked && summary?.kind === 'CONNECTOR' && Boolean(summary.providers.length);
  const tone = ssh ? 'ssh' : other ? 'connector' : summary ? 'disconnected' : 'unknown';
  const label = ssh ? 'SSH connected' : other ? `${summary!.providers.map(providerName).join(', ')} connected` : summary ? 'Not connected' : 'Connection status unavailable';
  return <div className={styles.connection} data-connection={tone}><span aria-hidden="true">{ssh || other ? '✓' : '○'}</span><div><strong>{label}</strong>{(ssh || other) && <small>Last checked {new Date(summary!.lastCheckedAt!).toLocaleString()}{other ? ' · read access only' : ''}</small>}</div></div>;
}

export function WebsiteCard({ website, openTools }: { website: WebsiteListItem; openTools: () => void }) {
  return <Card className={styles.card}>
    <div className={styles.identity}><span className={styles.siteIcon} aria-hidden="true">↗</span><div><h2>{website.name}</h2><a href={website.url} target="_blank" rel="noopener noreferrer">{website.url}</a></div></div>
    <WebsiteConnection website={website} />
    <div className={styles.actions}><Link className="ui-button ui-button--primary ui-button--md" href={`/customer/websites/${website.id}/services`}>Open workspace <span aria-hidden="true">→</span></Link><button type="button" className={styles.toolsButton} aria-haspopup="dialog" onClick={openTools}><span aria-hidden="true">⊞</span> Tools</button></div>
  </Card>;
}

/** One modal for the list: no duplicate dialog IDs and no tool execution endpoints. */
export function WebsiteTools({ website, close, initialTool, onChoose }: { website: WebsiteListItem | null; close: () => void; initialTool?: string; onChoose?: (name: string) => void }) {
  const [tool, setTool] = useState<string | null>(websiteTools.some(item => item.name === initialTool) ? initialTool! : null);
  const dialog = useRef<HTMLDialogElement>(null); const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null); const list = useRef<HTMLDivElement>(null); const previous = useRef<string | null>(null);
  useEffect(() => {
    if (website && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!website && dialog.current?.open) dialog.current.close();
  }, [website]);
  useEffect(() => {
    if (tool) { previous.current = tool; heading.current?.focus(); }
    else if (previous.current) Array.from(list.current?.querySelectorAll('button') ?? []).find(button => button.dataset.tool === previous.current)?.focus();
  }, [tool]);
  const dismiss = () => { if (dialog.current?.open) dialog.current.close(); setTool(null); previous.current = null; close(); };
  return <dialog ref={dialog} className="ui-dialog" aria-labelledby={titleId} onCancel={dismiss} onClose={dismiss} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const first = buttons[0]; const last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="ui-dialog__header"><h2 id={titleId}>Website tools</h2><Button variant="secondary" size="sm" onClick={dismiss} aria-label="Close dialog">Close</Button></div>
    <div className={styles.toolPanel}><p className={styles.toolSite}>{website?.name}</p>{tool ? <div className={styles.construction}>
      <span className={styles.constructionIcon} aria-hidden="true">◇</span><h3 ref={heading} tabIndex={-1}>{tool} · Under construction</h3><p>We’re building this tool. It isn’t available yet, and no work has started on your website.</p><button type="button" className={styles.backButton} onClick={() => setTool(null)}>← All tools</button>
    </div> : <><p className={styles.toolIntro}>Choose a tool to see its availability. These tools are under construction.</p><div ref={list} className={styles.toolList}>{websiteTools.map(item => <button key={item.name} data-tool={item.name} type="button" className={styles.toolOption} onClick={() => { setTool(item.name); onChoose?.(item.name); }}><span className={styles.toolIcon} aria-hidden="true">{item.symbol}</span><span><strong>{item.name}</strong><small>{item.description}</small><span className={styles.coming}>Under construction</span></span><span aria-hidden="true">→</span></button>)}</div></>}</div>
  </dialog>;
}
