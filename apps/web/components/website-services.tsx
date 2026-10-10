'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, ErrorState, LoadingState } from '@zerochack/ui';
import { api } from '../lib/api';
import { getWebsiteService, websiteServices, websiteWorkspaceHref } from '../lib/website-services';
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
    <header className={styles.heading}><span className={styles.eyebrow}>Step 1 of 2 · Choose your work</span><h1>What do you need help with?</h1><p>Select one service for <strong>{query.data.name}</strong>. Next, describe the work and how we should check it.</p><span className={styles.site}>{new URL(query.data.url).hostname}</span></header>
    <form onSubmit={event => { event.preventDefault(); if (chosen) router.push(websiteWorkspaceHref(websiteId, chosen)); }}>
      <fieldset className={styles.options}><legend className="sr-only">Website service</legend>{websiteServices.map(service => <label key={service.id} className={styles.option} data-selected={selection === service.id}>
        <input type="radio" name="website-service" value={service.id} checked={selection === service.id} onChange={() => setSelection(service.id)} />
        <span className={styles.number} aria-hidden="true">{service.code}</span><span className={styles.copy}><strong>{service.label}</strong><small>{service.description}</small></span>
      </label>)}</fieldset>
      <div className={styles.next}><p role="status">{chosen ? `Selected: ${chosen.label}` : 'Choose one service to continue.'}</p><Button disabled={!chosen}>Next: open workspace →</Button></div>
    </form>
    <p className={styles.notice}>Request planning is available for every service. Execution depends on verified access, available tools and your approval. Nothing starts when you select a service.</p>
  </section>;
}
