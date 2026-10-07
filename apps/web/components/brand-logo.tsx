import Image from 'next/image';

/** Faithful crops of the customer-supplied artwork. Never stretch the source. */
export function BrandLogo({ variant = 'horizontal', priority = false, decorative = false }: {
  variant?: 'horizontal' | 'full' | 'mark'; priority?: boolean; decorative?: boolean;
}) {
  const eager = { loading: priority ? 'eager' as const : 'lazy' as const, fetchPriority: priority ? 'high' as const : 'auto' as const };
  if (variant === 'full') return <span className="cb-brand cb-brand--full"><Image src="/brand/codebandage-logo.webp" width={484} height={379} alt={decorative ? '' : 'CodeBandage'} unoptimized {...eager} /></span>;
  if (variant === 'mark') return <span className="cb-brand cb-brand--mark"><Image src="/brand/codebandage-mark.png" width={192} height={192} alt={decorative ? '' : 'CodeBandage'} unoptimized {...eager} /></span>;
  return <span className="cb-brand cb-brand--horizontal"><Image className="cb-brand__mark" src="/brand/codebandage-mark.png" width={192} height={192} alt="" unoptimized {...eager} /><Image className="cb-brand__wordmark" src="/brand/codebandage-wordmark.webp" width={484} height={94} alt={decorative ? '' : 'CodeBandage'} unoptimized {...eager} /></span>;
}
