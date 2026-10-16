'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@zerochack/ui';
import { websiteNavigationLabel, type WebsiteNavigationActivity, type WebsiteNavigationClick } from '@zerochack/types';
import { api } from '../lib/api';
import { orderedOverviewWebsites, overviewWebsite, type OverviewWebsite } from '../lib/overview-websites';
import { websiteServices, websiteWorkspaceHref, websiteServiceUnderConstruction } from '../lib/website-services';
import { WebsiteConnection, WebsiteTools, websiteTools } from './website-card';
import { WebsiteServiceIcon } from './website-service-icon';
import { UptimeMonitor } from './uptime-monitor';
import styles from './customer-overview.module.css';

export function CustomerOverview({ websites }: { websites: OverviewWebsite[] }) {
  const router = useRouter(); const params = useSearchParams(); const client = useQueryClient(); const toast = useToast();
  const website = overviewWebsite(websites, params.get('website'));
  const [tool, setTool] = useState<{ websiteId: string; name: string } | null>(null);
  const activity = useQuery({ queryKey: ['overview-clicks', website?.id], queryFn: () => api<WebsiteNavigationActivity[]>(`/websites/${website!.id}/navigation-activity`), enabled: Boolean(website), retry: false });
  const record = (click: WebsiteNavigationClick) => {
    if (!website) return;
    const websiteId = website.id;
    void api(`/websites/${websiteId}/navigation-activity`, { method: 'POST', body: JSON.stringify(click), keepalive: true })
      .then(() => client.invalidateQueries({ queryKey: ['overview-clicks', websiteId] }))
      .catch(() => toast.notify('Could not save this click to your activity.', 'danger'));
  };
  return <div className={styles.page}>
    <header className={styles.heading}><h1>Overview</h1><p>One website. Your next step.</p></header>
    {!website ? <section className={styles.empty}><h2>Add your first website</h2><p>Your tools and workplace will appear here.</p><Link className="ui-button ui-button--primary ui-button--md" href="/customer/websites">Add website →</Link></section> : <>
      <section className={styles.switcher} aria-label="Selected website">
        <label htmlFor="overview-website">Switch website</label>
        <select id="overview-website" value={website.id} onChange={event => { setTool(null); router.replace(`/customer/overview?website=${encodeURIComponent(event.target.value)}`, { scroll: false }); }}>
          {orderedOverviewWebsites(websites).map(site => <option key={site.id} value={site.id}>{site.name} · {new URL(site.url).hostname}</option>)}
        </select>
        <div className={styles.site}><h2>{website.name}</h2><a href={website.url} target="_blank" rel="noopener noreferrer">{website.url}</a></div>
        <WebsiteConnection website={website} />
      </section>
      <UptimeMonitor key={website.id} websiteId={website.id} />
      <section className={styles.section} aria-labelledby="overview-tools"><div className={styles.sectionHeading}><span className={styles.number}>01</span><div><h2 id="overview-tools">Tools</h2><p>Website tools for {website.name}</p></div></div>
        <div className={styles.tools}>{websiteTools.map(item => <button className={styles.tool} data-overview-tool={item.id} type="button" aria-haspopup="dialog" key={item.id} onClick={() => { record({ section: 'TOOLS', option: item.id }); setTool({ websiteId: website.id, name: item.name }); }}><span className={styles.toolIcon} aria-hidden="true">{item.symbol}</span><strong>{item.name}</strong><small>Under construction</small><span aria-hidden="true">↗</span></button>)}</div>
      </section>
      <section className={styles.section} aria-labelledby="overview-workplace"><div className={styles.sectionHeading}><span className={styles.number}>02</span><div><h2 id="overview-workplace">Workplace</h2><p>Choose the work you need</p></div></div>
        <div className={styles.workplace}>{websiteServices.map(service => <Link className={styles.work} aria-label={service.label} key={service.id} href={websiteWorkspaceHref(website.id, service)} prefetch={false} onClick={() => record({ section: 'WORKPLACE', option: service.id })}><span className={styles.workIcon}><WebsiteServiceIcon service={service.id} /></span><span className={styles.workCopy}><strong>{service.label}</strong>{websiteServiceUnderConstruction(service) && <small>Under construction</small>}</span><span aria-hidden="true">→</span></Link>)}</div>
      </section>
      <section className={styles.section} aria-labelledby="overview-activity"><div className={styles.sectionHeading}><span className={styles.number}>03</span><div><h2 id="overview-activity">My activity log</h2><p>Your recent clicks on this website—not work results</p></div></div>
        {activity.isLoading ? <p role="status">Loading activity…</p> : activity.isError ? <div role="alert"><p>Activity is unavailable. Your tools and workplace are still accessible.</p><button className={styles.retry} type="button" onClick={() => void activity.refetch()}>Retry activity</button></div> : !activity.data?.length ? <p className={styles.noActivity}>No clicks yet. Choose a tool or workplace above.</p> : <><ol className={styles.activity}>{activity.data.map(entry => <li key={entry.id}><span className={styles.activityDot} aria-hidden="true" /><span><strong>{entry.section === 'TOOLS' ? 'Tools' : 'Workplace'} · {websiteNavigationLabel(entry)}</strong><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></span></li>)}</ol><small className={styles.limit}>Latest 50 clicks · visible only to you</small></>}
      </section>
      <WebsiteTools key={`${website.id}:${tool?.name ?? 'closed'}`} website={tool?.websiteId === website.id ? website : null} {...(tool ? { initialTool: tool.name } : {})} onChoose={name => { const item = websiteTools.find(choice => choice.name === name); if (item) record({ section: 'TOOLS', option: item.id }); }} close={() => setTool(null)} />
    </>}
  </div>;
}
