import { Routes, Route, Navigate } from 'react-router-dom';
import { getCredentials } from './auth';
import Login from './pages/Login';
import Callback from './pages/Callback';
import Home from './pages/Home';
import Project from './pages/Project';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const creds = getCredentials();
  if (!creds) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route path="/callback" element={<Callback />} />
      <Route
        path="/home"
        element={
          <RequireAuth>
            <Home />
          </RequireAuth>
        }
      />
      <Route
        path="/project/:id"
        element={
          <RequireAuth>
            <Project />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
