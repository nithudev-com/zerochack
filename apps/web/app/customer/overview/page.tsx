import { Overview } from '../../../components/overview';
import { Suspense } from 'react';
import { LoadingState } from '@zerochack/ui';
export default function Page() { return <Suspense fallback={<LoadingState label="Loading your overview" />}><Overview /></Suspense>; }
