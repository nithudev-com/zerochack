import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'CodeBandage — AI Website Security & Repair', short_name: 'CodeBandage',
    description: 'Website care, source reviews, supported repairs and specialist-led recovery.',
    start_url: '/', scope: '/', display: 'standalone', background_color: '#050509', theme_color: '#050509',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
}
