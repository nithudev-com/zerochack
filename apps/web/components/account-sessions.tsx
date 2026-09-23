'use client';
import { useRouter } from 'next/navigation'; import { useQuery } from '@tanstack/react-query'; import { Button, ErrorState, LoadingState, Table } from '@zerochack/ui';
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';
type Session = { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; ipAddress?: string; userAgent?: string };
export function AccountSessions() {
  const router = useRouter(); const query = useQuery<{ sessions: Session[] }>({ queryKey: ['sessions'], queryFn: async () => { const response = await fetch(`${apiUrl}/auth/sessions`, { credentials: 'include', cache: 'no-store' }); if (response.status === 401) { router.push('/'); throw new Error('Authentication required'); } if (!response.ok) throw new Error('Unable to load sessions'); return response.json(); } });
  const revokeAll = async () => { await fetch(`${apiUrl}/auth/sessions`, { method: 'DELETE', credentials: 'include' }); router.push('/'); };
  if (query.isLoading) return <LoadingState label="Loading sessions" />; if (query.error) return <ErrorState description={query.error.message} retry={() => void query.refetch()} />;
  return <div className="page-stack"><div className="section-heading"><div><h1>Account security</h1><p>Review devices with active sessions and revoke all access when needed.</p></div><Button variant="danger" onClick={revokeAll}>Log out all sessions</Button></div><Table caption="Active sessions" rows={query.data?.sessions ?? []} rowKey={(session) => session.id} columns={[{ key: 'device', header: 'Device', render: (session) => session.userAgent ?? 'Unknown device' }, { key: 'last', header: 'Last active', render: (session) => new Date(session.lastSeenAt).toLocaleString() }, { key: 'expires', header: 'Expires', render: (session) => new Date(session.expiresAt).toLocaleString() }]} /></div>;
}
