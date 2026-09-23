import { Alert } from '@zerochack/ui';
export function StatusPage({ title, description, tone = 'info' }: { title: string; description: string; tone?: 'info' | 'warning' | 'danger' }) { return <div className="status-page"><Alert title={title} tone={tone}>{description}</Alert><a className="text-link" href="/">Return to portal selection</a></div>; }
