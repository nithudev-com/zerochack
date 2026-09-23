import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return { name: 'ZeroRoot Website Security', short_name: 'ZeroRoot', description: 'Website security monitoring, scanning, recovery, and remediation.', start_url: '/', display: 'standalone', background_color: '#07120f', theme_color: '#07120f', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] };
}
