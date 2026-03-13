import type { Template } from '../types';
import './TemplateCard.css';

interface Props {
  template: Template;
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
}

/** A simple icon derived from the template id for visual variety. */
function TemplateIcon({ id }: { id: string }) {
  // Use a deterministic colour based on the id string
  const hue = [...id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  return (
    <div className="template-icon" style={{ background: `hsl(${hue}, 55%, 92%)` }}>
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect
          x="4"
          y="6"
          width="20"
          height="16"
          rx="3"
          stroke={`hsl(${hue}, 55%, 45%)`}
          strokeWidth="2"
          fill="none"
        />
        <line
          x1="4"
          y1="12"
          x2="24"
          y2="12"
          stroke={`hsl(${hue}, 55%, 45%)`}
          strokeWidth="2"
        />
      </svg>
    </div>
  );
}

export default function TemplateCard({ template, onClick, disabled, loading }: Props) {
  return (
    <button className="template-card" onClick={onClick} disabled={disabled}>
      <TemplateIcon id={template.id} />
      <span className="template-card-name">{template.name}</span>
      {loading && <span className="template-card-spinner" />}
    </button>
  );
}
