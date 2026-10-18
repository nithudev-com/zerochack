'use client';
import { useEffect, useState } from 'react';
import { ApiClientError } from '../lib/api';
import { retryDelayRemaining } from '../lib/query-policy';

export function QueryRecovery({ error, retry, background = false }: { error: Error; retry: () => void; background?: boolean }) {
  const [remaining, setRemaining] = useState(() => Math.ceil(retryDelayRemaining(error) / 1000));
  useEffect(() => {
    const update = () => setRemaining(Math.ceil(retryDelayRemaining(error) / 1000));
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [error]);
  const limited = error instanceof ApiClientError && error.status === 429;
  const denied = error instanceof ApiClientError && [401, 403, 404].includes(error.status);
  if (denied) return <section className="ui-card" aria-label="Workspace connection status"><p role="alert">{error.status === 404 ? 'This website workspace is unavailable for your account.' : 'Your session or access needs to be checked before reopening this workspace.'}</p><a className="ui-button ui-button--secondary" href="/sign-in">Go to sign in</a></section>;
  return <section className="ui-card" aria-label="Workspace connection status">
    <p role="status">{limited ? remaining > 0 ? `Updates are taking a short pause. Retrying in ${remaining} seconds.` : 'Updates can resume now.' : background ? 'Live updates are temporarily unavailable.' : 'We could not load the workspace.'} {background ? 'Your saved workspace and message draft stay open.' : 'The workspace will retry automatically; you do not need to reload the page.'}</p>
    {!limited && <p>{error.message}</p>}
    <button type="button" className="ui-button ui-button--secondary" disabled={remaining > 0} onClick={retry}>Retry updates</button>
  </section>;
}
