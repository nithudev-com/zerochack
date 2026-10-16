import type { WebsiteService } from '../lib/website-services';

/** Small, local icons: no external requests or generated brand artwork. */
export function WebsiteServiceIcon({ service }: { service: WebsiteService['id'] }) {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {service === 'security' && <><path d="M12 3 4.5 6v5c0 5 7.5 10 7.5 10s7.5-5 7.5-10V6L12 3Z"/><path d="m8.5 12 2.3 2.3 4.7-5"/></>}
    {service === 'development' && <><path d="m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16"/></>}
    {service === 'redesign' && <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M9 9v11M6 6.5h.01M9 6.5h.01m3 7h6m-6 3h4"/></>}
    {service === 'issue' && <><path d="m9 3 3 3 3-3M4 9h3m10 0h3M3 14h4m10 0h4M4 19l4-3m8 0 4 3"/><rect x="7" y="6" width="10" height="14" rx="5"/><path d="M12 10v6"/></>}
    {service === 'server' && <><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M13 6.5h4m-4 11h4M12 10v4"/></>}
    {service === 'seo' && <><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6M7 12l3-4 3 2"/></>}
    {service === 'automation' && <><path d="m13 2-9 12h7l-1 8 10-13h-8l1-7Z"/></>}
  </svg>;
}
