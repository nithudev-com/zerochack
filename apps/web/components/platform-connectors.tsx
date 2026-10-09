'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, ErrorState, Input, LoadingState } from '@zerochack/ui';
import { api } from '../lib/api';

type Adapter = { provider: string; name: string; researchId: number; usernameLabel: string | null; secretLabel: string; scope: string };
type Connection = { provider: string; endpoint: string; revision: number; status: string; authorizationExpiresAt: string; lastCheckedAt: string | null; lastErrorCode: string | null; secretStored: boolean };
type Platform = { id: number; platform: string; category: string; connection_method: string; required_information: string; limitations: string; official_sources: string[] };
type Catalog = { adapters: Adapter[]; research: { research_date: string; platforms: Platform[] } };
const labels: Record<string, string> = { CONFIGURED: 'Saved · not checked', CHECKING: 'Check in progress', AUTHENTICATED_READ: 'Authenticated read succeeded', NEEDS_ATTENTION: 'Connection needs attention', REVOKED: 'Access removed', WEBSITE_REVERIFICATION_REQUIRED: 'Verify website ownership again', AUTHORIZATION_EXPIRED: 'Authorization expired' };
const errors: Record<string, string> = { AUTHENTICATION_UNPROVEN: 'The endpoint did not reject an anonymous request. Authentication cannot be proven; check the platform and API address.', AUTH_OR_PERMISSION_DENIED: 'The provider rejected this credential or its read permissions.', RESPONSE_INVALID: 'The response was not the expected platform API format.', PROVIDER_UNAVAILABLE: 'The provider returned an unexpected status. Check API availability; redirects are not followed.', CONNECTION_FAILED: 'Secure connection failed. Check public DNS, the trusted HTTPS certificate and API availability.', CONNECTION_TIMEOUT: 'The provider did not respond within the bounded timeout.', WEBSITE_CHANGED: 'Website authorization changed during the check. Verify ownership again.', RESPONSE_TOO_LARGE: 'The provider returned more data than the safe response limit.', CREDENTIAL_FORMAT: 'The stored credential format is not supported. Replace it using the documented format.' };

export function PlatformConnectors() {
  const { websiteId } = useParams<{ websiteId: string }>(); const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null); const [search, setSearch] = useState(''); const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const base = `/websites/${websiteId}/connectors`; const queryKey = ['connectors', websiteId];
  const catalog = useQuery({ queryKey: ['connector-catalog'], queryFn: () => api<Catalog>('/connectors/catalog') });
  const saved = useQuery({ queryKey, queryFn: () => api<Connection[]>(base) });
  const site = useQuery({ queryKey: ['website', websiteId], queryFn: () => api<{ url: string; connectionStatus: string }>(`/websites/${websiteId}`) });
  const action = useMutation({ mutationFn: ({ row, remove }: { row: Connection; remove?: boolean }) => api<Connection | undefined>(`${base}/${row.provider}${remove ? '' : '/check'}`, { method: remove ? 'DELETE' : 'POST', body: JSON.stringify({ confirm: true, revision: row.revision }) }), onSettled: () => { setConfirmRevoke(null); void client.invalidateQueries({ queryKey }); } });
  if (catalog.isLoading || saved.isLoading || site.isLoading) return <LoadingState label="Loading connectors" />;
  if (catalog.isError || saved.isError || site.isError) return <ErrorState description="Connectors could not be loaded." retry={() => { void catalog.refetch(); void saved.refetch(); void site.refetch(); }} />;
  if (!catalog.data || !saved.data || !site.data) return null;
  const canConnect = site.data.connectionStatus === 'VERIFIED';
  const adapter = catalog.data.adapters.find(item => item.provider === selected);
  const research = catalog.data.research.platforms.filter(item => `${item.platform} ${item.category}`.toLowerCase().includes(search.toLowerCase())).slice(0, 15);
  return <div className="portal-stack platform-connectors">
    <header><span className="eyebrow">Website connections</span><h1>Connect your platform</h1><p>Keep SSH for server access, or connect a supported platform API using a separate, revocable credential.</p></header>
    <Card><h2>SSH server connection</h2><p>Your existing SSH connection is unchanged. Server access depends on your hosting plan and account permissions—not just the website framework. Hosted builders do not automatically provide SSH.</p><Link className="ui-button ui-button--secondary ui-button--md" href={`/customer/websites/${websiteId}/access`}>Manage SSH access</Link></Card>
    <Alert title="Read-only connection checks" tone="info">These API adapters perform real authenticated GET requests when you choose Check connection. They do not enable automatic scanning, editing, deployment, backups or browser login. A successful check applies only to the listed read operation at the recorded time.</Alert>
    {!canConnect && <Alert title="Ownership verification required" tone="warning">First <Link href={`/customer/websites/${websiteId}/settings`}>verify this website in Settings</Link>. Credentials can only be sent to the verified hostname over HTTPS.</Alert>}
    {action.isError && <Alert title="Request not completed" tone="danger">{action.error.message}</Alert>}
    <div className="website-grid">{catalog.data.adapters.map(item => {
      const row = saved.data!.find(connection => connection.provider === item.provider);
      return <Card key={item.provider}><h2>{item.name}</h2><p>{item.scope}</p><p><strong>{row ? labels[row.status] ?? 'Unknown state — check again' : 'Not configured'}</strong></p>
        {row && <><p className="connector-address">{row.endpoint}</p>{row.lastCheckedAt && <p>Last check: {new Date(row.lastCheckedAt).toLocaleString()}</p>}{row.lastErrorCode && <Alert title="Check unsuccessful" tone="danger">{errors[row.lastErrorCode] ?? 'The connection failed safely. Verify configuration and retry.'}</Alert>}{row.secretStored && <small>Check authorization expires {new Date(row.authorizationExpiresAt).toLocaleDateString()}.</small>}</>}
        <div className="portal-actions"><Button variant="secondary" disabled={!canConnect || action.isPending} onClick={() => setSelected(item.provider)}>{row?.secretStored ? `Replace ${item.name} credential` : `Set up ${item.name}`}</Button>
          {row?.secretStored && <><Button disabled={!canConnect || action.isPending || row.status === 'AUTHORIZATION_EXPIRED' || row.status === 'WEBSITE_REVERIFICATION_REQUIRED'} onClick={() => action.mutate({ row })}>{action.isPending && action.variables?.row.provider === row.provider ? 'Working…' : 'Check connection'}</Button><Button variant="secondary" disabled={action.isPending} onClick={() => setConfirmRevoke(item.provider)}>Remove access</Button></>}
        </div>{row && confirmRevoke === item.provider && <Alert title="Remove stored access?" tone="warning"><p>Future checks stop. An in-flight read may finish. Revoke the credential at the provider too; encrypted backups may retain older copies.</p><Button variant="danger" disabled={action.isPending} onClick={() => action.mutate({ row, remove: true })}>Confirm removal</Button><Button variant="secondary" onClick={() => setConfirmRevoke(null)}>Cancel</Button></Alert>}
      </Card>;
    })}</div>
    {adapter && <ConnectorForm key={adapter.provider} adapter={adapter} row={saved.data.find(row => row.provider === adapter.provider)} siteUrl={site.data.url} base={base} close={() => setSelected(null)} saved={() => { setSelected(null); void client.invalidateQueries({ queryKey }); }} />}
    <Card><h2>150-platform connection guide</h2><p>Your supplied research, dated {catalog.data.research.research_date}. This guide is not a list of 150 implemented integrations. Only the four adapters above have connection-check code; other platforms require additional implementation, account access and validation. No credentials are collected for unavailable adapters.</p><Input label="Search platform guide" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Shopify, Wix, Drupal…" />
      <p>Showing up to 15 matching platforms.</p>{research.length === 0 && <p>No matching platform.</p>}{research.map(item => <details key={item.id}><summary>{item.platform} · {catalog.data!.adapters.some(candidate => candidate.researchId === item.id) ? 'Read-check adapter above' : 'Guide only · not implemented'}</summary><p>{item.connection_method}</p><p>Required: {item.required_information}</p><p>Limitations: {item.limitations}</p><ul>{item.official_sources.filter(url => url.startsWith('https://')).map(url => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname} documentation</a></li>)}</ul></details>)}
    </Card>
  </div>;
}

function ConnectorForm({ adapter, row, siteUrl, base, close, saved }: { adapter: Adapter; row: Connection | undefined; siteUrl: string; base: string; close: () => void; saved: () => void }) {
  const [endpoint, setEndpoint] = useState(row?.endpoint ?? new URL('/', siteUrl).toString().replace(/^http:/u, 'https:'));
  const [username, setUsername] = useState(''); const [secret, setSecret] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const save = useMutation({ mutationFn: () => api(base, { method: 'PUT', body: JSON.stringify({ provider: adapter.provider, endpoint, username, secret, authorizationConfirmed: confirmed, revision: row?.revision ?? 0 }) }), onSuccess: () => { setSecret(''); saved(); } });
  return <Card><h2>Set up {adapter.name}</h2><form className="portal-stack" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
    <p>Use the HTTPS installation root, including any subdirectory—not an API endpoint. It must match this website’s verified hostname. A separate admin hostname must be added and ownership-verified as a separate website.</p>
    <Input label="Installation root URL" type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} required maxLength={2048} />
    {adapter.usernameLabel && <Input label={adapter.usernameLabel} autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} required maxLength={120} />}
    <Input label={adapter.secretLabel} type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} required maxLength={4096} />
    <p>Encrypted at rest. Never sent to AI or chat history. Saved credentials are not displayed again. Saving does not mean authentication succeeded.</p>
    <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required /> I control this website and authorize storage and user-requested read-only authentication checks for 30 days.</label>
    {save.isError && <Alert title="Credential not saved" tone="danger">{save.error.message}</Alert>}
    <div className="portal-actions"><Button disabled={save.isPending || !confirmed}>{save.isPending ? 'Saving…' : 'Save encrypted credential'}</Button><Button type="button" variant="secondary" disabled={save.isPending} onClick={() => { setSecret(''); close(); }}>Cancel</Button></div>
  </form></Card>;
}
