import Image from 'next/image';

/** Reviewed transparent artwork; emblem left, wordmark right, never stretched. */
export function BrandLogo({ variant = 'horizontal', priority = false, decorative = false }: {
  variant?: 'horizontal' | 'full' | 'mark'; priority?: boolean; decorative?: boolean;
}) {
  const eager = { loading: priority ? 'eager' as const : 'lazy' as const, fetchPriority: priority ? 'high' as const : 'auto' as const };
  if (variant === 'mark') return <span className="cb-brand cb-brand--mark"><Image src="/brand/codebandage-mark.png?v=blue-20261009" width={192} height={192} alt={decorative ? '' : 'CodeBandage'} unoptimized {...eager} /></span>;
  return <span className={`cb-brand cb-brand--horizontal${variant === 'full' ? ' cb-brand--full' : ''}`}><Image className="cb-brand__mark" src="/brand/codebandage-mark.png?v=blue-20261009" width={192} height={192} alt="" unoptimized {...eager} /><Image className="cb-brand__wordmark" src="/brand/codebandage-wordmark.webp?v=blue-20261009" width={1416} height={225} alt={decorative ? '' : 'CodeBandage'} unoptimized {...eager} /></span>;
}
