import { EmptyState } from '@zerochack/ui';
export default function NotFound() { return <EmptyState title="Page not found" description="The requested page does not exist." action={<a className="ui-button ui-button--secondary ui-button--md" href="/">Return home</a>} />; }
