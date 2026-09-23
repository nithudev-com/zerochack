'use client';
import { ErrorState } from '@zerochack/ui';
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <ErrorState description="The page could not be loaded safely." retry={reset} />; }
