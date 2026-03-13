import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { startLogin, getCredentials } from '../auth';
import './Login.css';

export default function Login() {
  const navigate = useNavigate();
  const [instanceUrl, setInstanceUrl] = useState('https://login.salesforce.com');
  const [clientId, setClientId] = useState(import.meta.env.VITE_SF_CLIENT_ID ?? '');
  const [error, setError] = useState('');

  // If already logged in, redirect to home
  if (getCredentials()) {
    navigate('/home', { replace: true });
  }

  async function handleLogin() {
    if (!clientId.trim()) {
      setError('Client ID is required.');
      return;
    }
    try {
      await startLogin(instanceUrl, clientId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="24" fill="var(--sf-blue)" />
            <path
              d="M14 28c0-5.52 4.48-10 10-10s10 4.48 10 10"
              stroke="white"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
            <circle cx="24" cy="18" r="4" fill="white" />
          </svg>
        </div>

        <h1>SF Project Service</h1>
        <p className="login-subtitle">Deploy Salesforce projects from templates</p>

        {error && <div className="login-error">{error}</div>}

        <label className="login-label" htmlFor="instanceUrl">
          Instance URL
        </label>
        <input
          id="instanceUrl"
          className="login-input"
          type="url"
          value={instanceUrl}
          onChange={(e) => setInstanceUrl(e.target.value)}
          placeholder="https://login.salesforce.com"
        />

        <label className="login-label" htmlFor="clientId">
          Client ID
        </label>
        <input
          id="clientId"
          className="login-input"
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Your Connected App Client ID"
        />

        <button className="login-button" onClick={handleLogin}>
          Login with Salesforce
        </button>
      </div>
    </div>
  );
}
