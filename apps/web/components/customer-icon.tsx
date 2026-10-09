export type CustomerIconName = 'overview' | 'websites' | 'support' | 'subscription' | 'billing' | 'notifications' | 'profile' | 'more' | 'close' | 'arrow' | 'plus' | 'shield' | 'activity' | 'backup' | 'logout' | 'refresh';
const paths: Record<CustomerIconName, string> = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  websites: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  support: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2-5A8.5 8.5 0 1 1 21 11.5ZM8 10h8M8 14h5',
  subscription: 'M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  billing: 'M3 5h18v14H3zM3 10h18M7 15h3',
  notifications: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4',
  profile: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  more: 'M4 11h2v2H4zM11 11h2v2h-2zM18 11h2v2h-2z',
  close: 'm6 6 12 12M6 18 18 6', arrow: 'M5 12h14m-6-6 6 6-6 6', plus: 'M12 5v14M5 12h14',
  shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6',
  activity: 'M2 12h5l3-8 4 16 3-8h5', backup: 'M5 7V3m0 4h4M5 7a8 8 0 1 1-1 9M12 7v5l3 2',
  logout: 'M9 4H4v16h5M9 12h12m-4-4 4 4-4 4', refresh: 'M20 4v5h-5M4 20v-5h5M5 9a7 7 0 0 1 12-4l3 4M4 15l3 4a7 7 0 0 0 12-4',
};
/** Decorative icons; the surrounding control supplies the accessible name. */
export function CustomerIcon({ name, className = '' }: { name: CustomerIconName; className?: string }) {
  return <svg className={`cw-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
