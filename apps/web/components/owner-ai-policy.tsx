'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, ErrorState, Input, LoadingState, Select, useToast } from '@zerochack/ui';
import { api } from '../lib/api';

type Policy = { enabled: boolean; requestsPerMinute: number; requestsPerUserMinute: number; maxConcurrent: number; dailyCostLimitMicros: number; updatedAt: string };
type Tenant = { id: string; name: string; aiPolicy: Policy | null };

function PolicyForm({ tenant }: { tenant: Tenant }) {
  const cache = useQueryClient(); const toast = useToast(); const policy = tenant.aiPolicy;
  const [enabled, setEnabled] = useState(policy?.enabled ?? false);
  const [budget, setBudget] = useState(String((policy?.dailyCostLimitMicros ?? 1_000_000) / 1_000_000));
  const [rate, setRate] = useState(String(policy?.requestsPerMinute ?? 6));
  const [userRate, setUserRate] = useState(String(policy?.requestsPerUserMinute ?? 3));
  const [concurrent, setConcurrent] = useState(String(policy?.maxConcurrent ?? 1));
  const valid = Number.isFinite(Number(budget)) && Number(budget) >= (enabled ? 0.000001 : 0) && Number(budget) <= 2000 && [rate, userRate, concurrent].every(value => Number.isInteger(Number(value)) && Number(value) > 0) && Number(rate) <= 100_000 && Number(userRate) <= 100_000 && Number(concurrent) <= 100;
  const save = useMutation({
    mutationFn: () => api(`/owner/ai/tenants/${tenant.id}/policy`, { method: 'PUT', body: JSON.stringify({ enabled, dailyCostLimitMicros: Math.round(Number(budget) * 1_000_000), requestsPerMinute: Number(rate), requestsPerUserMinute: Number(userRate), maxConcurrent: Number(concurrent) }) }),
    onSuccess: () => { toast.notify('Tenant AI policy saved', 'success'); void cache.invalidateQueries({ queryKey: ['owner-ai-tenants'] }); },
    onError: (error: Error) => toast.notify(error.message, 'danger')
  });
  return <form aria-label={`AI access for ${tenant.name}`} onSubmit={event => { event.preventDefault(); if (valid && !save.isPending) save.mutate(); }}>
    <fieldset disabled={save.isPending} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Enable AI for {tenant.name}</label>
      <Input label="Estimated daily spending threshold (USD)" type="number" min={enabled ? '0.000001' : '0'} max="2000" step="0.000001" required value={budget} onChange={event => setBudget(event.target.value)} />
      <Input label="Tenant requests per minute" type="number" min="1" max="100000" required value={rate} onChange={event => setRate(event.target.value)} />
      <Input label="Requests per user per minute" type="number" min="1" max="100000" required value={userRate} onChange={event => setUserRate(event.target.value)} />
      <Input label="Concurrent requests" type="number" min="1" max="100" required value={concurrent} onChange={event => setConcurrent(event.target.value)} />
      <p>This is an estimated UTC-day threshold, not a hard provider billing cap. In-flight requests can exceed it. Accurate model prices and provider-side spending controls are still required. Enabling chat does not enable repair or release tools.</p>
      <Button type="submit" disabled={!valid || save.isPending}>{save.isPending ? 'Saving policy…' : 'Save tenant AI policy'}</Button>
    </fieldset>
  </form>;
}

export function OwnerAiPolicy() {
  const [search, setSearch] = useState(''); const [tenantId, setTenantId] = useState('');
  const query = useQuery<Tenant[]>({ queryKey: ['owner-ai-tenants', search], queryFn: () => api(`/owner/ai/tenants?search=${encodeURIComponent(search)}`) });
  const selected = query.data?.find(tenant => tenant.id === tenantId);
  return <Card><span className="eyebrow">Step 4</span><h2>Tenant AI access</h2>
    <p>A saved API key alone does not enable customer chat. Select the customer organization and explicitly save its access and spending limits.</p>
    <Input label="Find tenant" type="search" maxLength={120} value={search} onChange={event => { setSearch(event.target.value); setTenantId(''); }} />
    {query.isLoading ? <LoadingState label="Loading tenant AI access" /> : query.isError ? <ErrorState description={query.error.message} retry={() => void query.refetch()} /> : <>
      <Select label="Customer organization" value={selected?.id ?? ''} onChange={event => setTenantId(event.target.value)}><option value="">Choose organization</option>{query.data?.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name} — {tenant.aiPolicy?.enabled ? 'AI enabled' : 'AI disabled'}</option>)}</Select>
      <small>Up to 100 matches. Search by organization name if needed. No organization is enabled automatically.</small>
      {selected ? <PolicyForm key={`${selected.id}:${selected.aiPolicy?.updatedAt ?? 'new'}`} tenant={selected} /> : null}
    </>}
  </Card>;
}
