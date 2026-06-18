import React from 'react';

const ORG_ID = window.__ESW_ORG_ID__ ?? '';
const CONFIG_NAME = window.__ESW_CONFIG_NAME__ ?? 'HelpAgent';
const SITE_URL = window.__ESW_SITE_URL__ ?? '';
const SCRT_URL = window.__ESW_SCRT_URL__ ?? '';

const isConfigured = Boolean(SITE_URL && SCRT_URL);

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

  const openChat = () => {
    if (window.embeddedservice_bootstrap?.utilAPI?.launchChat) {
      window.embeddedservice_bootstrap.utilAPI.launchChat();
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    openChat();
  };

  return (
    <div className="hero">
      <div className="avatar">✦</div>

      <h1>How can <span>Agentforce</span> help?</h1>

      {isConfigured ? (
        <>
          <form className="search-bar" onSubmit={handleSubmit}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0176d3" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Ask Agentforce"
              aria-label="Ask Agentforce"
            />
            <button type="submit" aria-label="Submit">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
            </button>
          </form>

          <div className="chips">
            <button className="chip" onClick={openChat}>Answer a question</button>
            <button className="chip" onClick={openChat}>Transfer to an agent</button>
            <button className="chip" onClick={openChat}>Get product help</button>
          </div>
        </>
      ) : (
        <div className="setup-notice">
          <strong>ESW not yet configured.</strong><br />
          Deploy this project to Salesforce, then set <code>window.__ESW_ORG_ID__</code>,
          {' '}<code>window.__ESW_SITE_URL__</code>, and <code>window.__ESW_SCRT_URL__</code>
          {' '}in the static resource to load the chat widget.
        </div>
      )}

      <p className="tagline">Powered by Agentforce</p>
    </div>
  );
}
