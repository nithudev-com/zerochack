'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, EmptyState, ErrorState, Input, LoadingState, useToast } from '@zerochack/ui';
import { api } from '../lib/api';
import { WebsiteCard, WebsiteTools, type WebsiteListItem } from './website-card';

type Website = WebsiteListItem;

export function Websites() {
  const client = useQueryClient(); const toast = useToast(); const router = useRouter(); const [name, setName] = useState(''); const [url, setUrl] = useState('');
  const [toolSite, setToolSite] = useState<Website | null>(null);
  const query = useQuery({ queryKey: ['websites'], queryFn: () => api<Website[]>('/websites') });
  const add = useMutation({ mutationFn: () => api<Website>('/websites', { method: 'POST', body: JSON.stringify({ name, url }) }), onSuccess: (website) => { setName(''); setUrl(''); toast.notify('Website added — choose the work you need', 'success'); void client.invalidateQueries({ queryKey: ['websites'] }); router.push(`/customer/websites/${website.id}/services`); }, onError: (error: Error) => toast.notify(error.message, 'danger') });
  return <div className="portal-stack"><header className="portal-heading"><div><span className="eyebrow">My Websites</span><h1>Websites</h1><p>Your websites, connections and workspaces in one place.</p></div></header>
    <Card className="add-website-card"><div><span className="eyebrow">Step 1</span><h2>Add the website you want to work on</h2><p>Choose security, development, redesign, fixes, server work, SEO or automation after adding your website.</p></div><form className="inline-form" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}><Input label="Website name" placeholder="My business website" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /><Input label="Website URL" type="url" placeholder="https://example.com" value={url} onChange={(event) => setUrl(event.target.value)} required /><Button disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add and continue'}</Button></form>{add.isError && <Alert tone="danger" title="Website not added">{add.error.message}</Alert>}</Card>
    {query.isLoading ? <LoadingState label="Loading websites" /> : query.isError ? <ErrorState description={query.error.message} retry={() => void query.refetch()} /> : query.data?.length === 0 ? <EmptyState title="No websites" description="Use the form above to add a website record." /> : <div className="website-grid">{query.data?.map(website => <WebsiteCard key={website.id} website={website} openTools={() => setToolSite(website)} />)}</div>}
    <WebsiteTools website={toolSite} close={() => setToolSite(null)} />
  </div>;
}
