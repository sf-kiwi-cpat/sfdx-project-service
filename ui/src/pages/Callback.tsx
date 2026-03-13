import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { exchangeCodeForToken } from '../auth';
import './Login.css'; /* reuse login styles for the centered card */

export default function Callback() {
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const clientId = import.meta.env.VITE_SF_CLIENT_ID ?? '';

    if (!code) {
      setError('No authorization code found in the URL.');
      return;
    }

    exchangeCodeForToken(code, clientId)
      .then(() => {
        navigate('/home', { replace: true });
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Token exchange failed');
      });
  }, [navigate]);

  if (error) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Authentication Error</h1>
          <div className="login-error" style={{ marginTop: 16 }}>
            {error}
          </div>
          <button className="login-button" onClick={() => navigate('/')}>
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Logging in...</h1>
        <p className="login-subtitle">Exchanging authorization code for access token</p>
      </div>
    </div>
  );
}
