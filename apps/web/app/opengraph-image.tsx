import { ImageResponse } from 'next/og';

export const alt = 'ZeroRoot — AI website, API, server and DevOps care';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '55px 70px', color: '#213728', background: '#f8f9f3', fontFamily: 'sans-serif', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 28, fontWeight: 700 }}><span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 45, height: 45, background: '#213728', color: '#d0fa89', borderRadius: 8 }}>Z</span>ZeroRoot<span style={{ marginLeft: 'auto', fontSize: 15, color: '#62745c', fontWeight: 400, letterSpacing: 2 }}>YOUR WHOLE WEB STACK</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', fontSize: 80, letterSpacing: -6, lineHeight: 1.05 }}><span>Review. Repair. Improve.</span><span style={{ color: '#527441' }}>Stay in control.</span></div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 25, borderTop: '1px solid #d1dcc7', fontSize: 23, color: '#566b4c' }}><span>Websites · Apps · APIs · Servers · DevOps</span><span style={{ display: 'flex', padding: '12px 20px', background: '#d0fa89', color: '#213728', fontSize: 20, borderRadius: 5 }}>One connected workspace ↗</span></div>
    </div>, size
  );
}
