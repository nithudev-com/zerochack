'use client';

import { useState } from 'react';

const examples = [
  { name: 'Design', prompt: 'Make my website and app easier to use on mobile.', role: 'Design review', title: 'A clearer first impression.', description: 'Review hierarchy, contrast and mobile layout. Turn the findings into a focused redesign brief.', items: ['Content hierarchy', 'Responsive layout', 'Accessible contrast'], file: 'design-review.md', tag: 'Suggested improvements', code: '' },
  { name: 'API', prompt: 'My API sometimes times out. Help me understand the code.', role: 'Backend & API review', title: 'Trace the issue. Plan the fix.', description: 'Review the supplied handler and integration logic. Identify validation, error-handling and timeout concerns for your developer.', items: ['Request validation', 'Authentication paths', 'Timeout handling'], file: 'api-review.md', tag: 'Source findings', code: 'API REVIEW / orders.ts\n\n01  Request & input validation\n02  Authentication & permissions\n03  Upstream timeout handling\n04  Consistent error responses' },
  { name: 'DevOps', prompt: 'Our deployment keeps failing. Where should we look?', role: 'Server & DevOps review', title: 'Make the next release clearer.', description: 'Review the supplied pipeline and container configuration. Get findings and a checklist for your engineer to verify.', items: ['Build configuration', 'Service readiness', 'Release checks'], file: 'deployment-review.md', tag: 'Proposed next steps', code: 'DEPLOYMENT REVIEW / pipeline.yml\n\n01  Build & dependency configuration\n02  Environment & service readiness\n03  Pipeline permissions\n04  Rollback prerequisites' },
  { name: 'Security', prompt: 'How can I strengthen my app and API security?', role: 'Defensive security review', title: 'Find the gaps in the source.', description: 'Review available authentication, validation and configuration evidence. Prioritize improvements with your authorized specialist.', items: ['Access controls', 'Input handling', 'Hardening guidance'], file: 'security-review.md', tag: 'Review findings', code: 'SECURITY REVIEW / supplied source\n\n01  Authorization boundaries\n02  Validation & data handling\n03  Least-privilege configuration\n04  Prioritized recommendations' },
  { name: 'Repair', prompt: 'The layout on my HTML landing page is broken. Can you help?', role: 'HTML repair', title: 'From a problem to a preview.', description: 'For supported standalone HTML pages, prepare a candidate repair and compare it before approving the next step.', items: ['Scoped repair plan', 'Candidate HTML preview', 'Your approval'], file: 'candidate-preview.html', tag: 'Ready for your review', code: '' }
] as const;

export function HomePreview() {
  const [selected, setSelected] = useState(2);
  const example = examples[selected] ?? examples[0];
  return <div className="zr-preview">
    <div className="zr-preview-heading"><span><span className="zr-mini-mark">Z</span> ZeroRoot Care</span><span className="zr-demo-label">Interactive example</span></div>
    <div className="zr-preview-tabs" aria-label="Explore a technology care example">{examples.map((item, index) => <button type="button" key={item.name} aria-pressed={selected === index} onClick={() => setSelected(index)}>{item.name}<span aria-hidden="true">↗</span></button>)}</div>
    <div className="zr-preview-body" aria-live="polite" aria-atomic="true">
      <div className="zr-preview-prompt"><span className="zr-avatar">You</span><p>{example.prompt}</p></div>
      <div className="zr-preview-response"><span className="zr-spark" aria-hidden="true">✳</span><div><span className="zr-review-role">{example.role}</span><h3>{example.title}</h3><p>{example.description}</p></div></div>
      {example.code ? <pre className="zr-example-code" aria-label="Example review checklist">{example.code}</pre> : <div className="zr-example-page" aria-hidden="true"><div className="zr-example-toolbar"><i/><i/><i/><span>your-website</span></div><div className="zr-example-layout"><div><span className="zr-skeleton zr-skeleton--short"/><b>A fresh start.<br/>A better experience.</b><span className="zr-skeleton"/><span className="zr-example-button"/></div><div className="zr-example-art"><span/><span/><span/></div></div></div>}
      <ul className="zr-preview-checks">{example.items.map(item => <li key={item}><span aria-hidden="true">✓</span>{item}</li>)}</ul>
      <div className="zr-preview-file"><span aria-hidden="true">▤</span><strong>{example.file}</strong><span>{example.tag}</span></div>
    </div>
    <div className="zr-preview-note"><span aria-hidden="true">◈</span> Illustrative workflow. No live system is connected.</div>
  </div>;
}
