import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTemplates, createProject } from '../api';
import { clearCredentials } from '../auth';
import TemplateCard from '../components/TemplateCard';
import type { Template } from '../types';
import './Home.css';

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
      {/* Header */}
      <header className="home-header">
        <div className="home-header-inner">
          <h1 className="home-title">SF Project Service</h1>
          <button className="home-logout" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>

      <main className="home-main">
        {/* Chat placeholder */}
        <section className="home-chat">
          <div className="home-chat-box">
            <input
              className="home-chat-input"
              type="text"
              placeholder="Ask me anything about your project..."
              disabled
            />
            <span className="home-chat-badge">Coming soon</span>
          </div>
        </section>

        {/* Templates */}
        <section className="home-templates">
          <h2 className="home-section-title">Start from a template</h2>

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
