import React from 'react';

const ORG_ID = '${ORG_ID}';
const CONFIG_NAME = 'HelpAgent';
const SITE_URL = 'https://${SITE_DOMAIN}/${ESW_URL}';
const SCRT_URL = '${SCRT_URL}';

// isConfigured is false when tokens haven't been substituted yet (local dev).
const isConfigured = !SITE_URL.includes('${');

const TOPICS = [
  { icon: '🙋', label: 'Get Help' },
  { icon: '📖', label: 'Topics' },
  { icon: '💬', label: 'Discuss' },
  { icon: '💡', label: 'Ideas' },
  { icon: '🔔', label: 'Updates' },
  { icon: '🛒', label: 'Orders' },
];

export default function App() {
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    if (!isConfigured) return;
    const script = document.createElement('script');
    script.src = `${SITE_URL}/assets/js/bootstrap.min.js`;
    script.id = 'HelpAgent_BootstrapScript';
    script.onload = () => {
      if (window.embeddedservice_bootstrap) {
        window.embeddedservice_bootstrap.settings.language = 'en_US';
        window.embeddedservice_bootstrap.init(ORG_ID, CONFIG_NAME, SITE_URL, {
          scrt2URL: SCRT_URL,
        });
      }
    };
    document.body.appendChild(script);
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (window.embeddedservice_bootstrap?.utilAPI?.launchChat) {
      window.embeddedservice_bootstrap.utilAPI.launchChat();
    }
  };

  return (
    <div className="page">
      <header className="nav">
        <div className="nav-inner">
          <div className="nav-logo">
            <div className="logo-mark">✦</div>
            <span className="logo-text">Help Center</span>
          </div>
          <nav className="nav-links">
            <a href="#">Home</a>
            <a href="#">Community</a>
            <a href="#">Support</a>
            <a href="#">Topics</a>
          </nav>
        </div>
      </header>

      <section className="hero">
        <div className="hero-inner">
          <h1>How can we help you?</h1>
          <form className="search-bar" onSubmit={handleSubmit}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search..."
              aria-label="Search help articles"
            />
            <button type="submit">Search</button>
          </form>
        </div>
      </section>

      <main className="content">
        <div className="content-inner">
          <div className="welcome-card">
            <h2>Welcome!</h2>
            <p>We're glad you're here. Ask our AI agent a question, or browse the topics below to find what you need.</p>
            <button className="btn-primary" onClick={handleSubmit}>Ask Agentforce</button>
          </div>

          <div className="topics-grid">
            {TOPICS.map(({ icon, label }) => (
              <button key={label} className="topic-card" onClick={handleSubmit}>
                <span className="topic-icon">{icon}</span>
                <span className="topic-label">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </main>

      <footer className="footer">
        <span>Powered by Agentforce</span>
      </footer>
    </div>
  );
}
