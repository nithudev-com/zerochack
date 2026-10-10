'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, ErrorState, Input, LoadingState } from '@zerochack/ui';
import { api } from '../lib/api';
import { WorkspacePage } from './workspace';
import styles from './website-connections.module.css';

type Adapter = { provider: string; name: string; researchId: number; usernameLabel: string | null; secretLabel: string; scope: string; endpointKind?: 'service'; defaultEndpoint?: string };
type Connection = { provider: string; endpoint: string; revision: number; status: string; authorizationExpiresAt: string; lastCheckedAt: string | null; lastErrorCode: string | null; secretStored: boolean };
type Platform = { id: number; platform: string; category: string; connection_method: string; required_information: string; limitations: string; official_sources: string[] };
type Catalog = { adapters: Adapter[]; research: { research_date: string; platforms: Platform[] } };
const shopifyErrors: Record<string, string> = { API_VERSION_MISMATCH: 'Shopify did not serve the reviewed API version. Contact support before retrying.', WEBSITE_BINDING_REQUIRED: 'The verified website is required for this check.', WEBSITE_MISMATCH: 'The provider’s returned site domains do not match this verified website. Check the selected site, its primary/custom domain and ownership in Settings.' };
const labels: Record<string, string> = { CONFIGURED: 'Saved · not checked', CHECKING: 'Check in progress', AUTHENTICATED_READ: 'Authenticated read succeeded', AUTHENTICATED_ACCOUNT: 'Project access checked · website binding pending', NEEDS_ATTENTION: 'Connection needs attention', REVOKED: 'Access removed', WEBSITE_REVERIFICATION_REQUIRED: 'Verify website ownership again', AUTHORIZATION_EXPIRED: 'Authorization expired' };
const errors: Record<string, string> = { AUTHENTICATION_UNPROVEN: 'The endpoint did not reject an anonymous request. Authentication cannot be proven; check the platform and API address.', AUTH_OR_PERMISSION_DENIED: 'The provider rejected this credential or its read permissions.', RESPONSE_INVALID: 'The response was not the expected platform API format.', PROVIDER_UNAVAILABLE: 'The provider returned an unexpected status. Check API availability; redirects are not followed.', CONNECTION_FAILED: 'Secure connection failed. Check public DNS, the trusted HTTPS certificate and API availability.', CONNECTION_TIMEOUT: 'The provider did not respond within the bounded timeout.', WEBSITE_CHANGED: 'Website authorization changed during the check. Verify ownership again.', RESPONSE_TOO_LARGE: 'The provider returned more data than the safe response limit.', CREDENTIAL_FORMAT: 'The stored credential format is not supported. Replace it using the documented format.' };

export function PlatformConnectors() {
  const { websiteId } = useParams<{ websiteId: string }>(); const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null); const [editing, setEditing] = useState(false); const [search, setSearch] = useState(''); const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [guideLimit, setGuideLimit] = useState(15);
  const [methodSearch, setMethodSearch] = useState('');
  const detail = useRef<HTMLElement>(null);
  useEffect(() => { if (selected && detail.current) { detail.current.focus({ preventScroll: true }); detail.current.scrollIntoView({ block: 'start', behavior: 'instant' }); } }, [selected, editing]);
  const base = `/websites/${websiteId}/connectors`; const queryKey = ['connectors', websiteId];
  const catalog = useQuery({ queryKey: ['connector-catalog'], queryFn: () => api<Catalog>('/connectors/catalog') });
  const saved = useQuery({ queryKey, queryFn: () => api<Connection[]>(base) });
  const site = useQuery({ queryKey: ['website', websiteId], queryFn: () => api<{ url: string; connectionStatus: string }>(`/websites/${websiteId}`) });
  const action = useMutation({ mutationFn: ({ row, remove }: { row: Connection; remove?: boolean }) => api<Connection | undefined>(`${base}/${row.provider}${remove ? '' : '/check'}`, { method: remove ? 'DELETE' : 'POST', body: JSON.stringify({ confirm: true, revision: row.revision }) }), onSettled: () => { setConfirmRevoke(null); void client.invalidateQueries({ queryKey }); } });
  if (catalog.isLoading || saved.isLoading || site.isLoading) return <LoadingState label="Loading connectors" />;
  if (site.isError) return <ErrorState description="Website could not be loaded." retry={() => void site.refetch()} />;
  if (catalog.isError || saved.isError) return <div className="portal-stack"><ErrorState description="Platform API connections could not be loaded. Existing SSH access is still available below." retry={() => { void catalog.refetch(); void saved.refetch(); }} /><Button variant="secondary" onClick={() => setSelected('ssh')}>SSH server</Button>{selected === 'ssh' && <WorkspacePage section="access" />}</div>;
  if (!catalog.data || !saved.data || !site.data) return null;
  const canConnect = site.data.connectionStatus === 'VERIFIED';
  const adapter = catalog.data.adapters.find(item => item.provider === selected);
  // Selecting a supported API opens its form, never a save or provider request.
  // Ownership verification still gates credential entry below.
  const choose = (provider: string) => { setSelected(provider); setEditing(provider !== 'ssh'); setConfirmRevoke(null); action.reset(); };
  const matches = catalog.data.research.platforms.filter(item => `${item.platform} ${item.category}`.toLowerCase().includes(search.toLowerCase()));
  const research = matches.slice(0, guideLimit);
  const methods = catalog.data.adapters.filter(item => item.name.toLowerCase().includes(methodSearch.toLowerCase()));
  return <div className="portal-stack platform-connectors">
    <header><span className="eyebrow">Website connections</span><h1>Connect your platform</h1><p>Choose how to connect. Your framework does not need to be WordPress: SSH is for hosts that provide server access; platform APIs have their own permissions.</p></header>
    <Input label="Search connection methods" type="search" value={methodSearch} onChange={event => setMethodSearch(event.target.value)} placeholder="Search available API adapters…" />
    <p role="status">{catalog.data.adapters.length} API read-check adapters available. Selecting a method never starts a check.</p>
    <div className={styles.choices} role="group" aria-label="Connection methods">
      <button className={styles.choice} type="button" aria-pressed={selected === 'ssh'} aria-controls="connection-details" onClick={() => choose('ssh')}><span className={styles.icon} aria-hidden="true">&gt;_</span><span><strong>SSH server</strong><small>Server account · key or password</small></span><span className={styles.arrow} aria-hidden="true">↗</span></button>
      {methods.map(item => <button key={item.provider} className={styles.choice} type="button" aria-pressed={selected === item.provider} aria-controls="connection-details" onClick={() => choose(item.provider)}><span className={styles.icon} aria-hidden="true">{item.name.slice(0, 2)}</span><span><strong>{item.name}</strong><small>Open setup · {item.secretLabel}</small></span><span className={styles.arrow} aria-hidden="true">↗</span></button>)}
    </div>
    {methods.length === 0 && <p>No API adapter matches. Search the 150-platform guide below for its documented setup requirements. SSH remains available only when your host provides it.</p>}
    {!selected && <p className={styles.hint}>Select a connection method above to see its setup form. No connection or task starts when you select a card.</p>}
    <section ref={detail} tabIndex={-1} id="connection-details" aria-label="Selected connection" className={styles.details}>
    {selected === 'ssh' && <WorkspacePage section="access" />}
    {adapter && <>
    {!canConnect && <Alert title="Ownership verification required" tone="warning">First <Link href={`/customer/websites/${websiteId}/settings`}>verify this website in Settings</Link>. Connections require trusted HTTPS and website ownership; Shopify also verifies the store’s domain binding.</Alert>}
    {editing && <ConnectorForm key={`${websiteId}:${adapter.provider}`} adapter={adapter} row={saved.data.find(row => row.provider === adapter.provider)} siteUrl={site.data.url} canConnect={canConnect} base={base} close={() => setEditing(false)} saved={() => { setEditing(false); void client.invalidateQueries({ queryKey }); }} />}
    <Alert title="Read-only connection checks" tone="info">These API adapters make authenticated read requests when you choose Check connection. Shopify also exchanges app credentials for a temporary token. They do not enable automatic scanning, editing, deployment, backups or browser login. A successful check applies only to the listed read operation at the recorded time.</Alert>
    {action.isError && <Alert title="Request not completed" tone="danger">{action.error.message}</Alert>}
    <div>{catalog.data.adapters.filter(item => item.provider === selected).map(item => {
      const row = saved.data!.find(connection => connection.provider === item.provider);
      return <Card key={item.provider}><h2>{item.name}</h2><p>{item.scope}</p><p><strong>{row ? labels[row.status] ?? 'Unknown state — check again' : 'Not configured'}</strong></p>
        {row && <><p className="connector-address">{row.endpoint}</p>{row.lastCheckedAt && <p>Last check: {new Date(row.lastCheckedAt).toLocaleString()}</p>}{row.lastErrorCode && <Alert title="Check unsuccessful" tone="danger">{errors[row.lastErrorCode] ?? shopifyErrors[row.lastErrorCode] ?? 'The connection failed safely. Verify configuration and retry.'}</Alert>}{row.secretStored && <small>Check authorization expires {new Date(row.authorizationExpiresAt).toLocaleDateString()}.</small>}</>}
        <div className="portal-actions"><Button variant="secondary" disabled={!canConnect || action.isPending} onClick={() => setEditing(true)}>{row?.secretStored ? `Replace ${item.name} credential` : `Set up ${item.name}`}</Button>
          {row?.secretStored && <><Button disabled={!canConnect || action.isPending || row.status === 'AUTHORIZATION_EXPIRED' || row.status === 'WEBSITE_REVERIFICATION_REQUIRED'} onClick={() => action.mutate({ row })}>{action.isPending && action.variables?.row.provider === row.provider ? 'Working…' : 'Check connection'}</Button><Button variant="secondary" disabled={action.isPending} onClick={() => setConfirmRevoke(item.provider)}>Remove access</Button></>}
        </div>{row && confirmRevoke === item.provider && <Alert title="Remove stored access?" tone="warning"><p>Future checks stop. An in-flight read may finish. Revoke the credential at the provider too; encrypted backups may retain older copies.</p><Button variant="danger" disabled={action.isPending} onClick={() => action.mutate({ row, remove: true })}>Confirm removal</Button><Button variant="secondary" onClick={() => setConfirmRevoke(null)}>Cancel</Button></Alert>}
      </Card>;
    })}</div>
    </>}
    </section>
    <Card><h2>Connect first. Approve each task separately.</h2><p>A connection check does not grant an AI permission to edit files, run customer code or release changes. Development, redesign and fixing also need an agreed scope, supported tools and your approval.</p><Link className="ui-button ui-button--secondary ui-button--md" href={`/customer/websites/${websiteId}`}>Open chat & task workspace</Link></Card>
    <details className={styles.guide}><summary>150-platform connection guide</summary><p>Your supplied research, dated {catalog.data.research.research_date}. This guide is not a list of 150 implemented integrations. The {catalog.data.adapters.length} API adapters above have connection-check code; other platforms require additional implementation, account access and validation. No credentials are collected for unavailable adapters. Current adapter setup instructions above take precedence over this research.</p><Input label="Search platform guide" type="search" value={search} onChange={event => { setSearch(event.target.value); setGuideLimit(15); }} placeholder="Shopify, Joomla, Wix, Drupal…" />
      <p role="status">Showing {research.length} of {matches.length} matching platforms.</p>{research.length === 0 && <p>No matching platform.</p>}{research.map(item => {
        const implemented = catalog.data!.adapters.find(candidate => candidate.researchId === item.id);
        return <details key={item.id}><summary>{item.platform} · {implemented ? 'Read-check adapter above' : 'Guide only · not implemented'}</summary><p>{item.connection_method}</p><p>Required: {item.required_information}</p><p>Limitations: {item.limitations}</p><ul>{item.official_sources.filter(url => url.startsWith('https://')).map(url => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname} documentation</a></li>)}</ul>{implemented ? <Button variant="secondary" onClick={() => { setMethodSearch(''); choose(implemented.provider); }}>Open {implemented.name} setup</Button> : <><p>No executable adapter is available for this method yet. Do not send login passwords, keys or invitation links in chat.</p><Link className="ui-button ui-button--secondary ui-button--md" href="/customer/support">Request platform integration</Link></>}</details>;
      })}
      {research.length < matches.length && <Button variant="secondary" onClick={() => setGuideLimit(limit => limit + 15)}>Show more platforms</Button>}
    </details>
  </div>;
}

function ConnectorForm({ adapter, row, siteUrl, canConnect, base, close, saved }: { adapter: Adapter; row: Connection | undefined; siteUrl: string; canConnect: boolean; base: string; close: () => void; saved: () => void }) {
  const shopify = adapter.provider === 'shopify';
  const wordpress = adapter.provider === 'wordpress';
  const [endpoint, setEndpoint] = useState(row?.endpoint ?? adapter.defaultEndpoint ?? (shopify && !new URL(siteUrl).hostname.endsWith('.myshopify.com') ? '' : new URL('/', siteUrl).toString().replace(/^http:/u, 'https:')));
  const [username, setUsername] = useState(''); const [secret, setSecret] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const save = useMutation({ mutationFn: () => { if (!canConnect) throw new Error('Verify website ownership in Settings before entering credentials.'); return api(base, { method: 'PUT', body: JSON.stringify({ provider: adapter.provider, endpoint, username, secret, authorizationConfirmed: confirmed, revision: row?.revision ?? 0 }) }); }, onSuccess: () => { setSecret(''); saved(); } });
  return <Card className={styles.setup}><h2>Set up {adapter.name}</h2><p className={styles.hint}>Add credentials, save securely, then check the connection. No connection starts automatically.</p><form className="portal-stack" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
    {!canConnect && <p>These fields are locked until website ownership is verified in Settings. SSH access and website ownership are separate checks.</p>}
    <fieldset className={`portal-stack ${styles.fields}`} disabled={!canConnect}>
    <p>{adapter.endpointKind === 'service' ? 'Use the vendor API root, not your website URL.' : shopify ? 'The app and store must belong to the same Shopify organization. Use the canonical myshopify.com URL.' : 'Use your site’s HTTPS installation root, including any subdirectory.'}</p>
    <Input label={adapter.endpointKind === 'service' ? 'Vendor API root URL' : shopify ? 'Canonical Shopify store URL' : 'Installation root URL'} type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} required maxLength={2048} />
    {adapter.usernameLabel && <Input label={adapter.usernameLabel} autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} required maxLength={120} />}
    <Input label={adapter.secretLabel} id={`connector-${adapter.provider}-secret`} type="password" autoComplete="new-password" aria-describedby={wordpress ? 'wordpress-password-help' : undefined} value={secret} onChange={event => setSecret(event.target.value)} required maxLength={4096} />
    {wordpress && <><p id="wordpress-password-help">Use a dedicated WordPress user’s Application Password, not their normal login password.</p><details className={styles.credentialHelp}><summary>Where to get an Application Password</summary><ol><li>Sign in to your own WordPress dashboard and open Users → Profile.</li><li>Find Application Passwords, name this credential CodeBandage, and choose Add New Application Password.</li><li>Copy the generated password into the field above. WordPress displays it only once; revoke it in that profile when you stop using this connection.</li></ol><p>If that section is unavailable, confirm your installation uses HTTPS and ask its administrator whether Application Passwords are supported or intentionally disabled. Do not disable security controls or share your main password.</p><a href="https://developer.wordpress.org/advanced-administration/security/application-passwords/" target="_blank" rel="noopener noreferrer">Official WordPress Application Password guide</a></details></>}
    <details className={styles.credentialHelp}><summary>URL and credential requirements</summary><p>{adapter.endpointKind === 'service' ? 'Only reviewed vendor API hosts are allowed. Contentful and DatoCMS prove project access only, not frontend website binding. Webflow checks the returned site ID and domain.' : shopify ? 'Use https://your-store.myshopify.com/, not your custom storefront domain. Your verified website must match the store’s primary domain or canonical myshopify.com domain. Do not use your Shopify login password or a Storefront API token.' : 'Enter the installation root, not an API endpoint. It must match this website’s verified hostname. Add and ownership-verify a separate admin hostname as its own website.'}</p></details>
    <p>Encrypted at rest. Never sent to AI or chat history. Saved credentials are not displayed again. Saving does not mean authentication succeeded.</p>
    <details className={styles.credentialHelp}><summary>{adapter.name} access requirements & limits</summary><p>{adapter.scope}</p></details>
    <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required /> I control this website and authorize storage and user-requested read-only authentication checks for 30 days.</label>
    </fieldset>
    {save.isError && <Alert title="Credential not saved" tone="danger">{save.error.message}</Alert>}
    <div className="portal-actions"><Button disabled={!canConnect || save.isPending || !confirmed}>{save.isPending ? 'Saving…' : 'Save encrypted credential'}</Button><Button type="button" variant="secondary" disabled={save.isPending} onClick={() => { setSecret(''); close(); }}>Cancel</Button></div>
  </form></Card>;
}
