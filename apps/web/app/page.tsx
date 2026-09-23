import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: { absolute: 'ZeroRoot Website Security | Monitoring, Scanning & Recovery' },
  description: 'Protect your website with continuous monitoring, vulnerability scanning, verified backups, clear security reports, and controlled expert remediation.',
  keywords: ['website security', 'website security monitoring', 'website vulnerability scanning', 'website backup and recovery', 'cybersecurity remediation', 'agency website security platform'],
  alternates: { canonical: '/' },
  openGraph: { title: 'ZeroRoot — Website Security Without the Guesswork', description: 'Continuous monitoring, security scanning, verified backups, and expert remediation in one clear workspace.', url: '/', type: 'website', siteName: 'ZeroRoot', locale: 'en_US', images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'ZeroRoot website security platform' }] },
  twitter: { card: 'summary_large_image', title: 'ZeroRoot — Website Security Without the Guesswork', description: 'Continuous monitoring, security scanning, verified backups, and expert remediation in one clear workspace.', images: ['/opengraph-image'] }
};

const Icon = ({ name }: { name: 'scan' | 'monitor' | 'backup' | 'fix' | 'check' | 'arrow' }) => {
  const paths = {
    scan: <><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><circle cx="12" cy="12" r="3"/></>,
    monitor: <><path d="M12 3 4.5 6v5.3c0 4.8 3.2 8 7.5 9.7 4.3-1.7 7.5-4.9 7.5-9.7V6L12 3Z"/><path d="m9.4 12.2 1.7 1.7 3.8-4"/></>,
    backup: <><path d="M20 15a4 4 0 0 0-3.6-4 5.5 5.5 0 0 0-10.7-1.4A3.5 3.5 0 0 0 6.5 16H9"/><path d="m12 15 3-3 3 3M15 12v8"/></>,
    fix: <><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L4 17l3 3 8.3-8.3a4 4 0 0 0 5-5L18 9l-2.4-2.4 2.3-2.3a4 4 0 0 0-3.2 2Z"/></>,
    check: <path d="m5 12 4 4L19 6"/>, arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
};

const features = [
  { icon: 'scan' as const, number: '01', title: 'Security scanning', copy: 'Turn complex website signals into prioritized findings with evidence your team can understand and act on.' },
  { icon: 'monitor' as const, number: '02', title: 'Continuous monitoring', copy: 'Watch the security indicators that matter and surface meaningful changes before they become larger incidents.' },
  { icon: 'backup' as const, number: '03', title: 'Verified recovery', copy: 'Build confidence with managed backup policies, protected restore points, and authorized recovery workflows.' },
  { icon: 'fix' as const, number: '04', title: 'Expert remediation', copy: 'Move from finding to fix with scoped specialist access, approval controls, and a complete audit trail.' }
];

const portals = [
  { label: 'Customer', path: 'customer', copy: 'Protect websites, review findings, manage backups, and work with security specialists.' },
  { label: 'Agency', path: 'agency', copy: 'Manage client security from one workspace with explicit access and clear commercial controls.' },
  { label: 'Affiliate', path: 'affiliate', copy: 'Track referrals, commissions, transactions, and payouts with transparent reporting.' }
];

const faqs = [
  ['What does ZeroRoot protect?', 'ZeroRoot helps customers and agencies manage website security operations: scans, findings, monitoring, backups, reports, and authorized remediation.'],
  ['Can agencies manage multiple clients?', 'Yes. Agency access is based on explicit client grants, with client and website scope enforced by the platform.'],
  ['Does ZeroRoot automatically change my website?', 'Scanning is read-only. Remediation uses separate, authorized workflows with scoped access, restore points, audit history, and post-remediation verification.'],
  ['How do I get started?', 'Create a customer account to set up your organization, then connect your first website from the secure workspace.']
];

export default function Home() {
  const siteUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${siteUrl}/#organization`,
        name: 'ZeroRoot',
        url: siteUrl,
        logo: { '@type': 'ImageObject', url: `${siteUrl}/brand/zeroroot-logo.webp`, width: 900, height: 450 }
      },
      {
        '@type': 'WebSite',
        '@id': `${siteUrl}/#website`,
        name: 'ZeroRoot',
        url: siteUrl,
        description: 'Website security monitoring, scanning, backup, recovery, and remediation platform.',
        publisher: { '@id': `${siteUrl}/#organization` },
        inLanguage: 'en-US'
      },
      {
        '@type': 'WebPage',
        '@id': `${siteUrl}/#webpage`,
        url: siteUrl,
        name: 'ZeroRoot Website Security, Monitoring, Scanning and Recovery',
        description: 'Continuous website security monitoring, vulnerability scanning, verified backups, reporting, and controlled expert remediation.',
        isPartOf: { '@id': `${siteUrl}/#website` },
        about: { '@id': `${siteUrl}/#software` },
        primaryImageOfPage: { '@type': 'ImageObject', url: `${siteUrl}/opengraph-image` },
        inLanguage: 'en-US'
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${siteUrl}/#software`,
        name: 'ZeroRoot',
        applicationCategory: 'SecurityApplication',
        applicationSubCategory: 'Website Security Platform',
        operatingSystem: 'Web',
        url: siteUrl,
        description: 'Website security operations platform for continuous monitoring, vulnerability scanning, verified backups, reporting, and expert remediation.',
        featureList: ['Website security scanning', 'Continuous security monitoring', 'Verified backups', 'Expert remediation workflows', 'Security reporting'],
        provider: { '@id': `${siteUrl}/#organization` }
      },
      {
        '@type': 'ItemList',
        name: 'ZeroRoot website security capabilities',
        itemListElement: features.map((feature, index) => ({ '@type': 'ListItem', position: index + 1, name: feature.title, description: feature.copy }))
      },
      {
        '@type': 'FAQPage',
        mainEntity: faqs.map(([question, answer]) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } }))
      }
    ]
  };
  return <div className="landing-page">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replaceAll('<', '\\u003c') }} />
    <section className="landing-hero" aria-labelledby="hero-title">
      <div className="hero-grid" aria-hidden="true"/><div className="hero-orb hero-orb--one" aria-hidden="true"/><div className="hero-orb hero-orb--two" aria-hidden="true"/>
      <div className="landing-container landing-hero__inner">
        <div className="landing-hero__copy"><div className="signal-pill"><span/> Continuous website protection</div><h1 id="hero-title">Your website’s<br/><span className="text-gradient">security command center.</span></h1><p className="hero-lead">Bring vulnerability scanning, continuous monitoring, verified backups, clear reporting, and controlled expert remediation into one protected workspace.</p><div className="hero-actions"><Link className="landing-button landing-button--primary" href="/customer/register">Protect your website <Icon name="arrow"/></Link><Link className="landing-button landing-button--ghost" href="/sign-in">Open your dashboard</Link></div><ul className="hero-checks" aria-label="Platform benefits"><li><Icon name="check"/> Read-only security scans</li><li><Icon name="check"/> Role-based access</li><li><Icon name="check"/> Auditable workflows</li></ul></div>
        <div className="security-visual" aria-label="ZeroRoot security workspace preview"><div className="visual-glow"/><div className="dashboard-window"><div className="dashboard-topbar"><div className="mini-brand"><span>Z</span> ZeroRoot</div><div className="window-dots"><i/><i/><i/></div></div><div className="dashboard-body"><div className="dashboard-sidebar"><i className="active"/><i/><i/><i/><i/></div><div className="dashboard-content"><div className="dashboard-heading"><div><span>SECURITY OVERVIEW</span><b>Your protection at a glance</b></div><em>Live</em></div><div className="score-panel"><div className="score-ring"><div><strong>A</strong><small>Posture</small></div></div><div className="score-copy"><span>Security posture</span><strong>Protected</strong><p>Monitoring is active and your latest checks are complete.</p></div></div><div className="visual-stats"><div><span>Active monitoring</span><strong>Online</strong><i className="status-line"><b style={{ width: '92%' }}/></i></div><div><span>Backup integrity</span><strong>Verified</strong><i className="status-line"><b style={{ width: '86%' }}/></i></div></div><div className="activity-card"><div><span className="activity-icon"><Icon name="check"/></span><p><strong>Security check complete</strong><small>No critical changes detected</small></p><time>Just now</time></div><div><span className="activity-icon purple"><Icon name="backup"/></span><p><strong>Recovery point verified</strong><small>Encrypted backup passed validation</small></p><time>2m</time></div></div></div></div></div><div className="floating-card floating-card--scan"><span><Icon name="scan"/></span><div><small>LATEST SCAN</small><strong>All checks complete</strong></div></div><div className="floating-card floating-card--shield"><span><Icon name="monitor"/></span><div><small>MONITORING</small><strong>Protection active</strong></div><i/></div></div>
      </div>
      <div className="hero-trust landing-container"><span>One workspace for</span><div><b>Security scans</b><b>Monitoring</b><b>Backups</b><b>Remediation</b><b>Reporting</b></div></div>
    </section>
    <section className="confidence-band" aria-label="ZeroRoot protection principles"><div className="landing-container"><article><span>01</span><div><strong>Continuous</strong><p>Security visibility that stays active between reviews.</p></div></article><article><span>02</span><div><strong>Read-only first</strong><p>Scanning observes safely before any authorized action.</p></div></article><article><span>03</span><div><strong>Verified recovery</strong><p>Protected restore points support confident recovery.</p></div></article><article><span>04</span><div><strong>Accountable</strong><p>Approvals, access, and outcomes remain traceable.</p></div></article></div></section>
    <section className="landing-section feature-section" id="security"><div className="landing-container"><div className="section-intro"><div><span className="section-kicker">Complete coverage</span><h2>See the risk.<br/>Control the response.</h2></div><p>ZeroRoot brings the moving parts of website security into one calm, connected system—so nothing important gets lost between detection and resolution.</p></div><div className="feature-grid">{features.map((feature) => <article className="feature-card" key={feature.title}><span className="feature-number">{feature.number}</span><div className="feature-icon"><Icon name={feature.icon}/></div><h3>{feature.title}</h3><p>{feature.copy}</p><span className="feature-link">Explore capability <Icon name="arrow"/></span></article>)}</div></div></section>
    <section className="intelligence-section"><div className="landing-container"><div className="intelligence-grid"><article className="intel-card intel-card--wide"><div><span className="section-kicker">Connected intelligence</span><h2>Every signal keeps its context.</h2><p>Findings, monitoring events, recovery points, tickets, and reports stay connected from first detection to verified resolution.</p></div><div className="signal-map" aria-hidden="true"><span className="map-core"><i/>Z</span><span className="map-node n1"><Icon name="scan"/></span><span className="map-node n2"><Icon name="monitor"/></span><span className="map-node n3"><Icon name="backup"/></span><span className="map-node n4"><Icon name="fix"/></span><i className="orbit o1"/><i className="orbit o2"/></div></article><article className="intel-card intel-card--access"><span className="intel-label">ACCESS CONTROL</span><div className="access-stack"><i/><i/><i/><span>Role verified</span></div><h3>The right access.<br/>Nothing more.</h3><p>Tenant boundaries and scoped permissions remain enforced through each protected action.</p></article><article className="intel-card intel-card--audit"><span className="intel-label">AUDIT TRAIL</span><div className="audit-stream"><i/><i/><i/><i/></div><h3>Accountability built in.</h3><p>Critical activity stays traceable without exposing protected credentials.</p></article></div></div></section>
    <section className="outcomes-section" aria-labelledby="outcomes-title"><div className="landing-container outcomes-grid"><div className="outcomes-copy"><span className="section-kicker">Operational confidence</span><h2 id="outcomes-title">Website security without the blind spots.</h2><p>ZeroRoot connects detection, evidence, ownership, recovery, and remediation so your team can understand what changed and decide what happens next.</p><Link className="inline-arrow-link" href="/customer/register">Start protecting your website <Icon name="arrow"/></Link></div><div className="outcome-stack"><article><span><Icon name="scan"/></span><div><small>DETECT</small><h3>Find meaningful risk earlier.</h3><p>Prioritized website security findings include the context needed for a clear response.</p></div><b>01</b></article><article><span><Icon name="backup"/></span><div><small>RECOVER</small><h3>Prepare before recovery is urgent.</h3><p>Managed backup policies and verified restore points create a safer path back.</p></div><b>02</b></article><article><span><Icon name="fix"/></span><div><small>RESOLVE</small><h3>Keep every fix controlled.</h3><p>Scoped specialist sessions and post-remediation checks protect accountability.</p></div><b>03</b></article></div></div></section>
    <section className="landing-section workflow-section" id="platform"><div className="landing-container workflow-grid"><div className="workflow-copy"><span className="section-kicker">From signal to solution</span><h2>Security that moves at the speed of your business.</h2><p>Replace scattered tools and unclear alerts with a guided operational flow. ZeroRoot keeps context, evidence, authorization, and outcomes connected.</p><ol><li><span>1</span><div><strong>Connect safely</strong><p>Add your website and verify ownership before protection begins.</p></div></li><li><span>2</span><div><strong>Understand what matters</strong><p>Review prioritized findings with useful evidence and plain-language context.</p></div></li><li><span>3</span><div><strong>Resolve with confidence</strong><p>Track fixes through controlled remediation and post-scan verification.</p></div></li></ol><Link className="inline-arrow-link" href="/customer/register">Create your security workspace <Icon name="arrow"/></Link></div><div className="workflow-visual" aria-hidden="true"><div className="radar"><i/><i/><i/><span className="radar-sweep"/><b className="radar-point p1"/><b className="radar-point p2"/><b className="radar-point p3"/><div className="radar-center"><Icon name="monitor"/></div></div><div className="workflow-status"><span className="pulse-dot"/><div><small>CONTINUOUS MONITORING</small><strong>Watching every security signal</strong></div></div></div></div></section>
    <section className="landing-section portals-section" id="portals"><div className="landing-container"><div className="center-intro"><span className="section-kicker">Built for every role</span><h2>One platform. The right view for you.</h2><p>Purpose-built workspaces keep every team focused while shared security controls protect access across the platform.</p></div><div className="portal-grid">{portals.map((portal, index) => <article className="portal-card" key={portal.path}><span className="portal-index">0{index + 1}</span><h3>{portal.label}</h3><p>{portal.copy}</p><div><Link href={`/${portal.path}/login`}>Sign in <Icon name="arrow"/></Link><Link href={`/${portal.path}/register`}>Create account</Link></div></article>)}</div><p className="owner-access">Platform owner? <Link href="/owner/login">Use the secure owner portal</Link></p></div></section>
    <section className="landing-section faq-section" id="faq"><div className="landing-container faq-grid"><div><span className="section-kicker">Common questions</span><h2>Clarity is part of security.</h2><p>Everything you need to know before creating your protected workspace.</p></div><div className="faq-list">{faqs.map(([question, answer], index) => <details key={question} open={index === 0}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div></div></section>
    <section className="landing-cta"><div className="cta-grid" aria-hidden="true"/><div className="landing-container"><span className="section-kicker">Ready when you are</span><h2>Make website security<br/>your strongest advantage.</h2><p>Build a clearer, safer path from detection to recovery with ZeroRoot.</p><div><Link className="landing-button landing-button--light" href="/customer/register">Get started now <Icon name="arrow"/></Link><Link className="landing-button landing-button--outline" href="/sign-in">Sign in to your workspace</Link></div></div></section>
  </div>;
}
