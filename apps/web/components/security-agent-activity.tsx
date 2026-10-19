import styles from './security-agent-activity.module.css';

const activityStates = {
  response_pending: { title: 'Preparing your response', message: 'Waiting for the assistant. This does not mean a website tool is running.', tone: 'active', badge: 'Assistant' },
  queued: { title: 'Inspection queued', message: 'The request is saved. Waiting for the inspection worker to start.', tone: 'active', badge: 'Queued' },
  running: { title: 'Inspection in progress', message: 'Waiting for the next saved server update.', tone: 'active', badge: 'Working' },
  connecting: { title: 'Checking SSH connection', message: 'Verifying the saved connection. This step does not authorize website changes.', tone: 'active', badge: 'Connecting' },
  inspecting_ssh: { title: 'Inspecting server evidence', message: 'The authorized SSH inspection is running. No repair is implied.', tone: 'active', badge: 'Inspecting' },
  checking_public_site: { title: 'Checking your public website', message: 'The authorized public HTTP checks are running.', tone: 'active', badge: 'Checking' },
  saving_evidence: { title: 'Saving inspection evidence', message: 'Saving the reported results for review.', tone: 'active', badge: 'Saving' },
  awaiting_approval: { title: 'Waiting for your approval', message: 'Review the proposed scope and recovery steps before approving a change.', tone: 'attention', badge: 'Approval needed' },
  applying: { title: 'Applying an approved change', message: 'The scoped repair is running. Completion requires its saved result and verification.', tone: 'active', badge: 'Applying' },
  verifying: { title: 'Verifying the result', message: 'Checking the approved change against its verification requirements.', tone: 'active', badge: 'Verifying' },
  completed: { title: 'Task completed', message: 'Review the saved result for what was checked. Completion alone does not mean a repair was applied.', tone: 'success', badge: 'Completed' },
  completed_limited: { title: 'Inspection finished', message: 'Some areas could not be fully checked. No repair was applied. This result is not proof that the website is clean or secured.', tone: 'attention', badge: 'Limited coverage' },
  blocked: { title: 'Action needed', message: 'Work is blocked. Review the saved reason before continuing.', tone: 'attention', badge: 'Blocked' },
  failed: { title: 'Work did not complete', message: 'Review the saved error and any partial results before retrying.', tone: 'error', badge: 'Failed' },
  cancelled: { title: 'Work cancelled', message: 'Review the saved results to see what finished before cancellation.', tone: 'neutral', badge: 'Cancelled' }
} as const;

export type SecurityAgentActivityState = keyof typeof activityStates;

export type SecurityAgentActivityProps = {
  /** Map only a confirmed request or persisted server state. Never advance on a timer. */
  state: SecurityAgentActivityState;
  /** Optional safe, redacted summary from the actual request or server result. */
  message?: string;
  /** A real persisted stage, not a predicted or animated sequence of tool calls. */
  latestStage?: string;
  /** Recorded, normalized coverage reasons. Render as text, never HTML or AI instructions. */
  coverageLimitations?: readonly string[];
  /** Safe persisted notice for historical inspection scope; never interpreted as HTML. */
  scopeWarning?: string;
};

/**
 * Presentation only: no requests, tool execution, elapsed-time simulation or
 * invented completion percentage. Applying/verifying require a real repair job;
 * an assistant response alone must use response_pending instead.
 */
export function SecurityAgentActivity({ state, message, latestStage, coverageLimitations = [], scopeWarning }: SecurityAgentActivityProps) {
  const activity = activityStates[state];
  const active = activity.tone === 'active';

  return <section className={styles.activity} data-agent-state={state} data-tone={activity.tone} aria-label="Agent activity">
    <span className={styles.indicator} aria-hidden="true">
      {active ? <span className={styles.orbit}><span /><span /><span /></span> : activity.tone === 'success' ? <svg viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" /></svg> : state === 'cancelled' ? <svg viewBox="0 0 24 24" fill="none"><path d="m8 8 8 8M16 8l-8 8" /></svg> : <svg viewBox="0 0 24 24" fill="none"><path d="M12 7v6m0 4h.01" /></svg>}
    </span>
    <div className={styles.content}>
      <div role="status" aria-live="polite" aria-atomic="true">
        <div className={styles.heading}><strong>{activity.title}</strong><span className={styles.badge}>{activity.badge}</span></div>
        <p>{message || activity.message}</p>
      </div>
      {scopeWarning ? <p className={styles.scopeWarning}>{scopeWarning}</p> : null}
      {latestStage ? <p className={styles.stage}><span>Latest server update</span>{latestStage}</p> : null}
      {state === 'completed_limited' ? <details className={styles.limitations}>
        <summary>View coverage limitations{coverageLimitations.length ? ` (${coverageLimitations.length})` : ''}</summary>
        {coverageLimitations.length ? <ul aria-label="Recorded coverage limitations">{coverageLimitations.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p>No detailed reason was recorded for this inspection. Review the saved findings and coverage before deciding next steps.</p>}
      </details> : null}
    </div>
  </section>;
}
