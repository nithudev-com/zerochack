import { Suspense } from 'react'; import { ResetPasswordForm } from '../../components/token-forms'; import { LoadingState } from '@zerochack/ui';
export default function Page() { return <div className="narrow-page"><h1>Reset password</h1><Suspense fallback={<LoadingState />}><ResetPasswordForm /></Suspense></div>; }
