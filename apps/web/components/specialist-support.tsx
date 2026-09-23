'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, EmptyState, ErrorState, LoadingState, useToast } from '@zerochack/ui';
import { api } from '../lib/api';

type Conversation = {
  id: string;
  subject: string;
  status: 'OPEN' | 'ASSIGNED' | 'CLOSED';
  updatedAt: string;
  customer: { displayName: string | null; email: string };
  assignedSpecialist?: { displayName: string | null } | null;
  _count: { messages: number };
};
type Message = { id: string; type: string; content: string; createdAt: string; author?: { displayName: string | null } | null };

export function SpecialistSupport() {
  const client = useQueryClient();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState('');
  const [content, setContent] = useState('');
  const conversations = useQuery({ queryKey: ['specialist-support'], queryFn: () => api<Conversation[]>('/specialist/support'), refetchInterval: 5_000 });
  const activeId = selectedId || conversations.data?.find((item) => item.status === 'ASSIGNED')?.id || conversations.data?.[0]?.id || '';
  const active = conversations.data?.find((item) => item.id === activeId);
  const messages = useQuery({ queryKey: ['specialist-support-messages', activeId], queryFn: () => api<Message[]>(`/specialist/support/${activeId}/messages`), enabled: Boolean(activeId && active?.status !== 'OPEN'), refetchInterval: 5_000 });
  const openCount = conversations.data?.filter((conversation) => conversation.status !== 'CLOSED').length ?? 0;
  const action = useMutation({
    mutationFn: ({ type, body }: { type: 'claim' | 'reply' | 'close'; body?: unknown }) => api(`/specialist/support/${activeId}/${type === 'reply' ? 'messages' : type}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }),
    onSuccess: (_value, input) => {
      if (input.type === 'reply') setContent('');
      toast.notify(input.type === 'claim' ? 'Conversation assigned to you' : input.type === 'close' ? 'Conversation closed' : 'Reply sent', 'success');
      void client.invalidateQueries({ queryKey: ['specialist-support'] });
      void client.invalidateQueries({ queryKey: ['specialist-support-messages', activeId] });
    },
    onError: (error: Error) => toast.notify(error.message, 'danger')
  });

  if (conversations.isLoading) return <LoadingState label="Loading General Live Help" />;
  if (conversations.isError) return <ErrorState description={conversations.error.message} retry={() => void conversations.refetch()} />;

  return <section className="support-center specialist-help" aria-labelledby="specialist-support-title">
    <header className="support-center__bar">
      <div className="support-brand-mark" aria-hidden="true">?</div>
      <div className="support-center__title"><span>Agent workspace</span><h1 id="specialist-support-title">General Live Help</h1><p>Respond to customer support conversations.</p></div>
      <div className="support-availability"><i /> {openCount} open</div>
    </header>

    <div className="support-center__body">
      <aside className="support-inbox" aria-label="Customer support queue">
        <div className="support-inbox__heading"><h2>Inbox</h2><span>{conversations.data?.length ?? 0}</span></div>
        {conversations.data?.length ? <nav>{conversations.data.map((conversation) => <button key={conversation.id} type="button" className={conversation.id === activeId ? 'is-active' : ''} onClick={() => setSelectedId(conversation.id)}>
          <span className="support-list-mark" aria-hidden="true">{(conversation.customer.displayName || conversation.customer.email).charAt(0).toUpperCase()}</span>
          <span className="support-list-copy"><strong>{conversation.subject}</strong><span>{conversation.customer.displayName || conversation.customer.email}</span></span>
          <small>{conversation._count.messages}</small>
        </button>)}</nav> : <div className="support-inbox__empty"><strong>Inbox is clear</strong><span>New conversations will appear here.</span></div>}
      </aside>

      <main className="support-thread">
        {!active ? <EmptyState title="Select a conversation" description="Choose a customer conversation from the inbox." /> : <>
          <header className="support-thread__header">
            <div className="support-list-mark" aria-hidden="true">{(active.customer.displayName || active.customer.email).charAt(0).toUpperCase()}</div>
            <div><h2>{active.subject}</h2><p>{active.customer.displayName || active.customer.email}</p></div>
            <span className={`support-status support-status--${active.status.toLowerCase()}`}>{active.status === 'OPEN' ? 'Waiting' : active.status === 'ASSIGNED' ? 'Assigned' : 'Closed'}</span>
            {active.status === 'OPEN' ? <Button size="sm" onClick={() => action.mutate({ type: 'claim' })}>Claim</Button> : active.status === 'ASSIGNED' ? <Button size="sm" variant="secondary" onClick={() => action.mutate({ type: 'close' })}>Close</Button> : null}
          </header>
          {active.status === 'OPEN' ? <EmptyState title="Claim to reply" description="Assign this conversation to yourself to view and reply." /> : messages.isLoading ? <LoadingState label="Loading messages" /> : messages.isError ? <ErrorState description={messages.error.message} retry={() => void messages.refetch()} /> : messages.data?.length ? <div className="support-messages" aria-live="polite">{messages.data.map((message) => <article key={message.id} className={`support-message support-message--${message.type.toLowerCase()}`}>
            <div><strong>{message.type === 'CUSTOMER' ? active.customer.displayName || 'Customer' : message.type === 'SPECIALIST' ? 'You' : 'ZeroRoot Support'}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
            <p>{message.content}</p>
          </article>)}</div> : <EmptyState title="No messages" description="This conversation has no messages." />}
          {active.status === 'ASSIGNED' && <form className="support-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); if (content.trim()) action.mutate({ type: 'reply', body: { content } }); }}>
            <label className="sr-only" htmlFor="specialist-help-reply">Reply</label>
            <textarea id="specialist-help-reply" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Type your reply…" required maxLength={4000} />
            <div className="support-composer__footer"><span>General support only. Fix work stays in My Tickets.</span><Button size="sm" disabled={action.isPending}>{action.isPending ? 'Sending…' : 'Send reply'}</Button></div>
          </form>}
          {action.isError && <div className="support-error"><Alert title="Action failed" tone="danger">{action.error.message}</Alert></div>}
        </>}
      </main>
    </div>
  </section>;
}
