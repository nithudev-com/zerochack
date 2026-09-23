'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, EmptyState, ErrorState, Input, LoadingState, useToast } from '@zerochack/ui';
import { api } from '../lib/api';

type Website = { id: string; name: string; url: string; connectionStatus: string; securityStatus: string; monitoringStatus: string; backupStatus: string; lastScanAt: string | null; _count: { findings: number } };
const status = (value: string) => value.replaceAll('_', ' ').toLowerCase();

export function Websites() {
  const client = useQueryClient(); const toast = useToast(); const router = useRouter(); const [name, setName] = useState(''); const [url, setUrl] = useState('');
  const query = useQuery({ queryKey: ['websites'], queryFn: () => api<Website[]>('/websites') });
  const add = useMutation({ mutationFn: () => api<Website>('/websites', { method: 'POST', body: JSON.stringify({ name, url }) }), onSuccess: (website) => { setName(''); setUrl(''); toast.notify('Website added — let’s connect it', 'success'); void client.invalidateQueries({ queryKey: ['websites'] }); router.push(`/customer/websites/${website.id}`); }, onError: (error: Error) => toast.notify(error.message, 'danger') });
  return <div className="portal-stack"><header className="portal-heading"><div><span className="eyebrow">My Websites</span><h1>Websites</h1><p>Connection remains pending until ownership is verified.</p></div></header>
    <Card className="add-website-card"><div><span className="eyebrow">Step 1</span><h2>Add the website you want to protect</h2><p>We will guide you through ownership, secure access, scanning, and any specialist fixes.</p></div><form className="inline-form" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}><Input label="Website name" placeholder="My business website" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /><Input label="Website URL" type="url" placeholder="https://example.com" value={url} onChange={(event) => setUrl(event.target.value)} required /><Button disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add and continue'}</Button></form>{add.isError && <Alert tone="danger" title="Website not added">{add.error.message}</Alert>}</Card>
    {query.isLoading ? <LoadingState label="Loading websites" /> : query.isError ? <ErrorState description={query.error.message} retry={() => void query.refetch()} /> : query.data?.length === 0 ? <EmptyState title="No websites" description="Use the form above to add a website record." /> : <div className="website-grid">{query.data?.map((website) => <Card key={website.id} className="website-card"><div><span className="status-pill">{status(website.connectionStatus)}</span><h2>{website.name}</h2><a href={website.url} target="_blank" rel="noreferrer">{website.url}</a></div><dl><div><dt>Security</dt><dd>{status(website.securityStatus)}</dd></div><div><dt>Monitoring</dt><dd>{status(website.monitoringStatus)}</dd></div><div><dt>Backups</dt><dd>{status(website.backupStatus)}</dd></div><div><dt>Last scan</dt><dd>{website.lastScanAt ? new Date(website.lastScanAt).toLocaleString() : 'Never'}</dd></div><div><dt>Open issues</dt><dd>{website._count.findings}</dd></div></dl><Link className="ui-button ui-button--primary ui-button--md" href={`/customer/websites/${website.id}`}>Open workspace</Link></Card>)}</div>}
  </div>;
}
