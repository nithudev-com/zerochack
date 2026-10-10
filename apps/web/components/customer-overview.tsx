import Link from 'next/link';
import { CustomerIcon, type CustomerIconName } from './customer-icon';
import type { CustomerOverviewData } from './overview';

const readable = (value: string) => value.replaceAll('_', ' ').toLowerCase();
const count = (value: number) => value.toLocaleString();

export function CustomerOverview({ data, refreshing, refresh }: { data: CustomerOverviewData; refreshing: boolean; refresh: () => void }) {
  const empty = data.monitoring.total === 0;
  const needsAttention = data.criticalFindings > 0 || data.securityPosture === 'CRITICAL' || data.securityPosture === 'ATTENTION';
  const posture = empty ? 'Setup needed' : needsAttention ? 'Needs attention' : data.securityPosture === 'HEALTHY' ? 'Healthy' : 'Not assessed';
  const metrics: Array<{ label: string; value: string; detail: string; icon: CustomerIconName }> = [
    { label: 'Verified websites', value: count(data.protectedWebsites), detail: `${count(data.monitoring.total)} total in your workspace`, icon: 'websites' },
    { label: 'Open findings', value: count(data.openFindings), detail: `${count(data.criticalFindings)} critical findings`, icon: 'shield' },
    { label: 'Monitoring', value: `${count(data.monitoring.active)} / ${count(data.monitoring.total)}`, detail: 'Websites with active monitoring', icon: 'activity' },
    { label: 'Backups', value: `${count(data.backups.active)} / ${count(data.backups.total)}`, detail: 'Websites with backups active', icon: 'backup' },
  ];
  return <div className="cw-overview">
    <header className="cw-page-heading"><div><span className="cw-eyebrow">CUSTOMER WORKSPACE</span><h1>Overview<span>.</span></h1><p>Your websites, with a clearer next step.</p></div><button className="cw-icon-button cw-refresh" type="button" disabled={refreshing} onClick={refresh} aria-label={refreshing ? 'Refreshing overview' : 'Refresh overview'}><CustomerIcon name="refresh" /></button></header>
    <section className="cw-welcome" aria-labelledby="cw-welcome-title"><div className="cw-welcome-copy"><span className="cw-welcome-label"><CustomerIcon name="shield" />WEBSITE CARE, SIMPLIFIED</span><h2 id="cw-welcome-title">{empty ? <>Your first website.<br /><span>A confident next step.</span></> : <>Your websites.<br /><span>Everything in perspective.</span></>}</h2><p>{empty ? 'Add your website to start ownership verification and keep your care in one place.' : 'Review your website status, follow up on findings, and keep your next action in sight.'}</p><Link className="cw-button cw-button-light" href="/customer/websites"><CustomerIcon name={empty ? 'plus' : 'websites'} />{empty ? 'Add your first website' : 'Manage websites'}<CustomerIcon name="arrow" /></Link></div><div className="cw-welcome-art" aria-hidden="true"><div><CustomerIcon name="shield" /></div><span>CodeBandage care</span></div></section>
    <section className="cw-stats-section" aria-labelledby="cw-stats-title"><div className="cw-section-heading"><h2 id="cw-stats-title">At a glance</h2><span>Account overview</span></div><div className="cw-metrics">{metrics.map(({ label, value, detail, icon }) => <Link className="cw-metric" href="/customer/websites" key={label}><span className="cw-metric-icon"><CustomerIcon name={icon} /></span><span className="cw-metric-label">{label}</span><strong>{value}</strong><span className="cw-metric-detail">{detail}</span><CustomerIcon name="arrow" className="cw-metric-arrow" /></Link>)}</div></section>
    <div className="cw-overview-columns">
      <section className="cw-panel" aria-labelledby="cw-attention-title"><div className="cw-panel-heading"><div><span className="cw-eyebrow">YOUR NEXT STEPS</span><h2 id="cw-attention-title">What needs attention</h2></div><span className={`cw-posture${needsAttention ? ' cw-posture--attention' : ''}`}>{posture}</span></div>
        {empty && <div className="cw-get-started"><span className="cw-soft-icon"><CustomerIcon name="websites" /></span><div><h3>Make this space yours</h3><p>Add a website, then verify ownership. Security status appears when assessment data is available.</p><Link href="/customer/websites">Set up a website <CustomerIcon name="arrow" /></Link></div></div>}
        <div className="cw-attention-list">
          <Link href="/customer/websites"><span className={`cw-soft-icon${data.criticalFindings ? ' cw-soft-icon--warning' : ''}`}><CustomerIcon name="shield" /></span><span><strong>Critical findings</strong><small>{data.criticalFindings ? 'Review urgent website findings' : 'No critical findings recorded'}</small></span><b>{count(data.criticalFindings)}</b><CustomerIcon name="arrow" /></Link>
          <Link href="/customer/websites"><span className="cw-soft-icon"><CustomerIcon name="support" /></span><span><strong>Website tickets</strong><small>Continue your website conversations</small></span><b>{count(data.openTickets)}</b><CustomerIcon name="arrow" /></Link>
          <Link href="/customer/notifications"><span className="cw-soft-icon"><CustomerIcon name="notifications" /></span><span><strong>Unread updates</strong><small>Account and security notifications</small></span><b>{count(data.unreadNotifications)}</b><CustomerIcon name="arrow" /></Link>
        </div>
      </section>
      <section className="cw-panel cw-details-panel" aria-labelledby="cw-status-title"><div className="cw-panel-heading"><div><span className="cw-eyebrow">STAY INFORMED</span><h2 id="cw-status-title">Care status</h2></div><CustomerIcon name="activity" /></div><dl className="cw-status-list"><div><dt>Latest scan</dt><dd>{data.latestScan ? <><strong>{readable(data.latestScan.status)}</strong><time dateTime={data.latestScan.requestedAt}>Requested {new Date(data.latestScan.requestedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time></> : <><strong>No scans yet</strong><span>Scan results will appear here.</span></>}</dd></div><div><dt>Your subscription</dt><dd><strong>{data.subscription?.planName ?? 'No subscription'}</strong><span>{data.subscription ? readable(data.subscription.status) : 'Explore the available plans.'}</span></dd></div></dl><Link className="cw-text-link" href="/customer/subscription">View subscription <CustomerIcon name="arrow" /></Link><div className="cw-help-note"><CustomerIcon name="support" /><div><strong>Need a hand?</strong><p>Start a general live help conversation.</p><Link href="/customer/support">Open help <CustomerIcon name="arrow" /></Link></div></div></section>
    </div>
    <section className="cw-quick-actions" aria-labelledby="cw-actions-title"><div className="cw-section-heading"><h2 id="cw-actions-title">Quick access</h2></div><div><Link href="/customer/billing"><CustomerIcon name="billing" /><span>Billing & invoices</span><CustomerIcon name="arrow" /></Link><Link href="/customer/profile"><CustomerIcon name="profile" /><span>Profile & security</span><CustomerIcon name="arrow" /></Link><Link href="/account"><CustomerIcon name="shield" /><span>Manage sessions</span><CustomerIcon name="arrow" /></Link></div></section>
    <p className="cw-overview-footnote"><CustomerIcon name="shield" />Status reflects recorded data, not a guarantee of protection.</p>
  </div>;
}
