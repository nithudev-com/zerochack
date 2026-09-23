import { ImageResponse } from 'next/og';

export const alt = 'ZeroRoot — Website security without the guesswork';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(<div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 70, color: '#f4fff9', background: 'linear-gradient(135deg,#07120f 0%,#0b2119 65%,#143a29 100%)', fontFamily: 'sans-serif' }}><div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 32, fontWeight: 700 }}><span style={{ width: 54, height: 54, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 14, color: '#07120f', background: '#b8ff3e' }}>Z</span>ZeroRoot</div><div style={{ display: 'flex', flexDirection: 'column' }}><span style={{ color: '#b8ff3e', fontSize: 22, letterSpacing: 5, textTransform: 'uppercase' }}>Website security, simplified</span><strong style={{ maxWidth: 1000, marginTop: 20, fontSize: 78, lineHeight: 1.02, letterSpacing: -4 }}>Your website’s security command center.</strong></div><div style={{ color: '#a6beb4', fontSize: 24 }}>Monitoring · Scanning · Backups · Remediation</div></div>, size);
}
