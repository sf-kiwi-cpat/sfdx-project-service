import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTemplates, createProject } from '../api';
import { clearCredentials } from '../auth';
import TemplateCard from '../components/TemplateCard';
import type { Template } from '../types';
import './Home.css';

function LogoDots() {
  return (
    <div className="app-logo-icon" aria-hidden="true">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="app-logo-dot" />
      ))}
    </div>
  );
}

function HeroIcon() {
  return (
    <div className="hero-icon" aria-hidden="true">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="hero-icon-dot" />
      ))}
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    getTemplates()
      .then(setTemplates)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load templates'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSelectTemplate(templateId: string) {
    try {
      setCreating(templateId);
      const { id } = await createProject(templateId);
      navigate(`/project/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
      setCreating(null);
    }
  }

  function handleLogout() {
    clearCredentials();
    navigate('/', { replace: true });
  }

  return (
    <div className="home-page">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-logo">
            <LogoDots />
            App Studio
          </div>
          <button className="btn-ghost" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <HeroIcon />
          <div className="home-chat-box">
            <input
              className="home-chat-input"
              type="text"
              placeholder="Ask me to build features, fix bugs, or work on your project..."
              disabled
            />
            <div className="home-chat-actions">
              <button className="home-chat-add" disabled aria-label="Attach">
                +
              </button>
              <button className="home-chat-send" disabled aria-label="Send">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 12V2M7 2L2 7M7 2L12 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </section>

        <section className="home-templates">
          <p className="home-section-title">Start from a template</p>

          {loading && <p className="home-status">Loading templates...</p>}
          {error && <p className="home-status home-status--error">{error}</p>}

          <div className="home-template-grid">
            {templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                disabled={creating !== null}
                loading={creating === t.id}
                onClick={() => handleSelectTemplate(t.id)}
              />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
