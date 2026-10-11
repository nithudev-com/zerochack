'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, ErrorState, LoadingState } from '@zerochack/ui';
import { api } from '../lib/api';
import { getWebsiteService, websiteServices, websiteWorkspaceHref, websiteServiceUnderConstruction, type WebsiteService } from '../lib/website-services';
import styles from './website-services.module.css';

export function WebsiteServices() {
  const { websiteId } = useParams<{ websiteId: string }>();
  const router = useRouter(); const params = useSearchParams();
  const [selection, setSelection] = useState(getWebsiteService(params.get('service'))?.id ?? '');
  const query = useQuery({ queryKey: ['website', websiteId], queryFn: () => api<{ name: string; url: string }>(`/websites/${websiteId}`) });
  if (query.isLoading) return <LoadingState label="Loading website services" />;
  if (query.isError) return <ErrorState description={query.error.message} retry={() => void query.refetch()} />;
  if (!query.data) return null;
  const chosen = getWebsiteService(selection);
  return <section className={styles.page} aria-label="Choose website service">
    <Link className={styles.back} href="/customer/websites">← My websites</Link>
    <header className={styles.heading}><span className={styles.eyebrow}>Choose your work</span><h1>What do you need help with?</h1><p>Select one service for <strong>{query.data.name}</strong>. Planned services are marked under construction.</p><span className={styles.site}>{new URL(query.data.url).hostname}</span></header>
    <form onSubmit={event => { event.preventDefault(); if (chosen) router.push(websiteWorkspaceHref(websiteId, chosen)); }}>
      <fieldset className={styles.options}><legend className="sr-only">Website service</legend>{websiteServices.map(service => <label key={service.id} className={styles.option} data-selected={selection === service.id}>
        <input type="radio" name="website-service" value={service.id} checked={selection === service.id} onChange={() => setSelection(service.id)} />
        <span className={styles.number} aria-hidden="true">{service.code}</span><span className={styles.copy}><strong>{service.label}</strong>{websiteServiceUnderConstruction(service) && <span className={styles.badge}>Under construction</span>}<small>{service.description}</small></span>
      </label>)}</fieldset>
      <div className={styles.next}><p role="status">{chosen ? `Selected: ${chosen.label}${websiteServiceUnderConstruction(chosen) ? ' · Coming soon' : ''}` : 'Choose one service to continue.'}</p><Button disabled={!chosen}>{chosen && websiteServiceUnderConstruction(chosen) ? 'Next: view details' : 'Next: open workspace'} →</Button></div>
    </form>
    <p className={styles.notice}>Development, redesign, issue fixes, server-side work, SEO and automation are coming soon. Selecting them only opens a preview; no request or work starts. Fix hacks &amp; security keeps its existing access and approval requirements.</p>
  </section>;
}

export function WebsiteServiceComingSoon({ website, service }: { website: { id: string; name: string; url: string }; service: WebsiteService }) {
  return <section className={`${styles.page} ${styles.preview}`} aria-label={`${service.label} preview`}>
    <Link className={styles.back} href={`/customer/overview?website=${encodeURIComponent(website.id)}`}>← Back to Overview</Link>
    <header className={styles.heading}><span className={styles.badge}>Under construction</span><h1>{service.label}</h1><p>This workplace is coming soon. We’re developing it for you.</p><span className={styles.site}>{website.name} · {new URL(website.url).hostname}</span></header>
    <p className={styles.notice}>This service is not available yet. No request, AI job or website change has started.</p>
    <Link className="ui-button ui-button--secondary ui-button--md" href={websiteWorkspaceHref(website.id, service, '/services')}>Change service</Link>
  </section>;
}
