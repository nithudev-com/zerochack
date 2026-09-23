'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, EmptyState, ErrorState, Input, LoadingState, useToast } from '@zerochack/ui';
import { api } from '../lib/api';

type Conversation = {
  id: string;
  subject: string;
  status: string;
  updatedAt: string;
  assignedSpecialist?: { displayName: string | null } | null;
  _count: { messages: number };
};

type Message = {
  id: string;
  type: 'CUSTOMER' | 'AI' | 'SPECIALIST' | 'SYSTEM';
  content: string;
  createdAt: string;
  author?: { displayName: string | null } | null;
};

function conversationStatus(conversation: Conversation): string {
  if (conversation.status === 'CLOSED') return 'Closed';
  if (conversation.assignedSpecialist?.displayName) return conversation.assignedSpecialist.displayName;
  return 'Waiting for agent';
}

export function CustomerSupport() {
  const client = useQueryClient();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState('');
  const [newChat, setNewChat] = useState(false);
  const [subject, setSubject] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [content, setContent] = useState('');

  const conversations = useQuery({ queryKey: ['support-conversations'], queryFn: () => api<Conversation[]>('/support/conversations'), refetchInterval: 5_000 });
  const activeId = selectedId || conversations.data?.[0]?.id || '';
  const active = conversations.data?.find((item) => item.id === activeId);
  const messages = useQuery({ queryKey: ['support-messages', activeId], queryFn: () => api<Message[]>(`/support/conversations/${activeId}/messages`), enabled: Boolean(activeId), refetchInterval: 5_000 });
  const create = useMutation({
    mutationFn: () => api<Conversation>('/support/conversations', { method: 'POST', body: JSON.stringify({ subject, message: firstMessage }) }),
    onSuccess: (conversation) => {
      setSelectedId(conversation.id);
      setSubject('');
      setFirstMessage('');
      setNewChat(false);
      toast.notify('Conversation started', 'success');
      void client.invalidateQueries({ queryKey: ['support-conversations'] });
    },
    onError: (error: Error) => toast.notify(error.message, 'danger')
  });
  const send = useMutation({
    mutationFn: () => api(`/support/conversations/${activeId}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
    onSuccess: () => {
      setContent('');
      void client.invalidateQueries({ queryKey: ['support-messages', activeId] });
      void client.invalidateQueries({ queryKey: ['support-conversations'] });
    },
    onError: (error: Error) => toast.notify(error.message, 'danger')
  });

  if (conversations.isLoading) return <LoadingState label="Opening General Live Help" />;
  if (conversations.isError) return <ErrorState description={conversations.error.message} retry={() => void conversations.refetch()} />;

  return <section className="support-center" aria-labelledby="support-title">
    <header className="support-center__bar">
      <div className="support-brand-mark" aria-hidden="true">?</div>
      <div className="support-center__title"><span>Customer support</span><h1 id="support-title">General Live Help</h1><p>Chat directly with a ZeroRoot support agent.</p></div>
      <div className="support-availability"><i /> Support online</div>
      <Button size="sm" onClick={() => { setNewChat(true); setSelectedId(''); }}>New conversation</Button>
    </header>

    <div className="support-center__body">
      <aside className="support-inbox" aria-label="Your support conversations">
        <div className="support-inbox__heading"><h2>Conversations</h2><span>{conversations.data?.length ?? 0}</span></div>
        {conversations.data?.length ? <nav>{conversations.data.map((conversation) => <button key={conversation.id} type="button" className={conversation.id === activeId && !newChat ? 'is-active' : ''} onClick={() => { setSelectedId(conversation.id); setNewChat(false); }}>
          <span className="support-list-mark" aria-hidden="true">{conversation.subject.charAt(0).toUpperCase()}</span>
          <span className="support-list-copy"><strong>{conversation.subject}</strong><span>{conversationStatus(conversation)}</span></span>
          <small>{conversation._count.messages}</small>
        </button>)}</nav> : <div className="support-inbox__empty"><strong>No conversations</strong><span>Your support history will appear here.</span></div>}
      </aside>

      <main className="support-thread">
        {newChat || !active ? <form className="support-new" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
          <div className="support-new__heading"><span className="support-list-mark" aria-hidden="true">+</span><div><h2>Start a conversation</h2><p>Tell our support team how we can help.</p></div></div>
          <Input label="Subject" placeholder="What do you need help with?" value={subject} onChange={(event) => setSubject(event.target.value)} required minLength={2} />
          <label className="support-field"><span>Message</span><textarea value={firstMessage} onChange={(event) => setFirstMessage(event.target.value)} placeholder="Describe your question. Do not include passwords or private keys." required maxLength={4000} /></label>
          <div className="support-actions"><Button disabled={create.isPending}>{create.isPending ? 'Starting…' : 'Send to support'}</Button>{conversations.data?.length ? <Button type="button" variant="secondary" onClick={() => setNewChat(false)}>Cancel</Button> : null}</div>
        </form> : <>
          <header className="support-thread__header">
            <div className="support-list-mark support-list-mark--agent" aria-hidden="true">ZR</div>
            <div><h2>{active.subject}</h2><p>{active.assignedSpecialist?.displayName ? `Agent: ${active.assignedSpecialist.displayName}` : 'ZeroRoot support team'}</p></div>
            <span className={`support-status support-status--${active.status.toLowerCase()}`}>{active.status === 'CLOSED' ? 'Closed' : active.assignedSpecialist ? 'Agent joined' : 'Waiting'}</span>
          </header>
          {messages.isLoading ? <LoadingState label="Loading messages" /> : messages.isError ? <ErrorState description={messages.error.message} retry={() => void messages.refetch()} /> : messages.data?.length ? <div className="support-messages" aria-live="polite">{messages.data.map((message) => <article key={message.id} className={`support-message support-message--${message.type.toLowerCase()}`}>
            <div><strong>{message.type === 'CUSTOMER' ? 'You' : message.type === 'SPECIALIST' ? message.author?.displayName || 'Support Agent' : 'ZeroRoot Support'}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
            <p>{message.content}</p>
          </article>)}</div> : <EmptyState title="No messages" description="Send the first message to begin." />}
          {active.status !== 'CLOSED' && <form className="support-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); if (content.trim()) send.mutate(); }}>
            <label className="sr-only" htmlFor="general-help-message">Message</label>
            <textarea id="general-help-message" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Type your message…" required maxLength={4000} />
            <div className="support-composer__footer"><span>Replies go directly to the support agent.</span><Button size="sm" disabled={send.isPending}>{send.isPending ? 'Sending…' : 'Send message'}</Button></div>
          </form>}
          {send.isError && <div className="support-error"><Alert title="Message not sent" tone="danger">{send.error.message}</Alert></div>}
        </>}
      </main>
    </div>
  </section>;
}
