import { Suspense } from 'react'; import { VerifyEmailForm } from '../../components/token-forms'; import { LoadingState } from '@zerochack/ui';
export default function Page() { return <div className="narrow-page"><h1>Verify your email</h1><Suspense fallback={<LoadingState />}><VerifyEmailForm /></Suspense></div>; }
