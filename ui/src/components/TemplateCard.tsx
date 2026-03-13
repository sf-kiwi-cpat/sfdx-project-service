import type { Template } from '../types';
import './TemplateCard.css';

interface Props {
  template: Template;
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
}

function TemplateVisual({ id }: { id: string }) {
  const hue = [...id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  const color = `hsl(${hue}, 45%, 55%)`;
  const colorFaint = `hsl(${hue}, 45%, 20%)`;

  return (
    <div className="template-visual" style={{ background: `hsl(${hue}, 30%, 10%)` }}>
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <rect x="8" y="14" width="48" height="36" rx="4" stroke={colorFaint} strokeWidth="1.5" />
        <rect x="8" y="14" width="48" height="8" rx="4" fill={colorFaint} />
        <line x1="16" y1="30" x2="40" y2="30" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <line x1="16" y1="36" x2="48" y2="36" stroke={colorFaint} strokeWidth="1.5" strokeLinecap="round" />
        <line x1="16" y1="42" x2="34" y2="42" stroke={colorFaint} strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="12" cy="18" r="1.5" fill={color} />
        <circle cx="17" cy="18" r="1.5" fill={color} />
        <circle cx="22" cy="18" r="1.5" fill={color} />
      </svg>
    </div>
  );
}

export default function TemplateCard({ template, onClick, disabled, loading }: Props) {
  return (
    <button className="template-card" onClick={onClick} disabled={disabled}>
      <div className="template-card-body">
        <span className="template-card-badge">Template</span>
        <span className="template-card-name">{template.name}</span>
        <span className="template-card-desc">
          Create a new Salesforce project from this template
        </span>
      </div>
      <TemplateVisual id={template.id} />
      {loading && <span className="template-card-spinner" />}
    </button>
  );
}
