'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { websiteServices as tasks, websiteWorkspaceHref, websiteServiceUnderConstruction, type WebsiteService } from '../lib/website-services';
import { WebsiteServiceComingSoon } from './website-services';
import styles from './website-task-panel.module.css';
import { WebsiteServiceIcon } from './website-service-icon';

export function WebsiteTaskPanel({ website, service, state, capabilities, onReview }: {
  website: { id: string; name: string; url: string }; environment: string;
  service?: WebsiteService;
  state: 'loading' | 'disabled' | 'unavailable' | 'available';
  capabilities: { sourceReview?: boolean; isolatedRepair: boolean; deployment: boolean } | undefined;
  onReview: () => void;
}) {
  const router = useRouter();
  const disabled = state === 'disabled';
  const source = state === 'available' && capabilities?.sourceReview === true;
  const status = (enabled: boolean | undefined) => state === 'loading' ? 'Checking availability' : state === 'unavailable' ? 'Status unavailable' : disabled || !enabled ? 'Disabled in this deployment' : 'Enabled gate · job checks still required';
  if (service && websiteServiceUnderConstruction(service)) return <WebsiteServiceComingSoon website={website} service={service}/>;
  return <section className={`care-panel ${styles.panel}`} aria-label="Website tasks and tools">
    <div className={`care-panel-heading ${styles.heading}`}><div><span className={styles.eyebrow}>YOUR NEXT PROJECT</span><h3>What would you like to build or improve?</h3></div><Link href={websiteWorkspaceHref(website.id, service, '/access')}>Connections →</Link></div>
    <p className={styles.intro}>Choose a workplace. Planned services are coming soon; selecting them only opens a preview.</p>
    <div className={styles.services} aria-label="Website work types">{tasks.map(item => <button className={styles.service} key={item.id} type="button" aria-label={item.label} onClick={() => router.push(websiteWorkspaceHref(website.id, item))}><span className={styles.icon}><WebsiteServiceIcon service={item.id}/></span><span className={styles.serviceCopy}><strong>{item.label}</strong><small className={styles.description}>{websiteServiceUnderConstruction(item) ? 'Under construction · Coming soon' : item.description}</small><small className={styles.compactDescription}>{websiteServiceUnderConstruction(item) ? 'Under construction' : 'Recovery & protection'}</small></span><span className={styles.arrow} aria-hidden="true">↗</span></button>)}</div>
    <p className={styles.scopeNote}>No work starts when you select a service. Fix hacks &amp; security keeps its existing access and approval requirements.</p>
    <details><summary>Tools & availability</summary>
      <p>{disabled ? 'Care workflows are disabled on this server. The Owner must complete provider, authorization and runtime validation before activation.' : state === 'unavailable' ? 'Tool availability could not be verified. Retry the workspace; no tool is assumed ready.' : 'Flags are not proof of a working provider or runner. Each job still needs its own prerequisites, consent and results.'}</p>
      <dl>
        <dt>AI source review</dt><dd>{status(capabilities?.sourceReview)}. Reviewed source files, configured provider/model, budget and exact plan approval required.</dd>
        <dt>Text edits, saved versions, snapshot lint & types</dt><dd>{status(capabilities?.sourceReview)}. Open a text workspace from an approved source revision. Static checks do not run your application.</dd>
        <dt>Automated repair</dt><dd>{status(capabilities?.isolatedRepair)}. Requires scoped source, an isolated runtime and a reviewed repair plan.</dd>
        <dt>Browser & runtime verification</dt><dd>{disabled ? 'Disabled with Care.' : 'Not verified here; check the individual job preflight.'} No customer code runs on the application host.</dd>
        <dt>Production release</dt><dd>{status(capabilities?.isolatedRepair && capabilities?.deployment)}. Separate release authorization and recovery evidence required.</dd>
      </dl>
      <button type="button" disabled={!source} onClick={onReview}>Prepare AI source review</button>
      <p>Planned workplaces are not enabled tools. Unsupported platform integrations are labelled guide-only in Connections.</p>
    </details>
  </section>;
}
