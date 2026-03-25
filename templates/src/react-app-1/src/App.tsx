import React, { useState, useEffect } from 'react';
import './styles.css';

interface Activity {
  id: number;
  action: string;
  target: string;
  time: string;
  status: 'success' | 'pending' | 'error';
}

const ACTIONS = ['Deployed', 'Created', 'Updated', 'Synced', 'Built'];
const TARGETS = [
  'Account trigger',
  'Contact flow',
  'Opportunity layout',
  'Custom object',
  'Apex class',
  'Lightning component',
  'Permission set',
  'Validation rule',
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function timeAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export default function App() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [stats, setStats] = useState({ deploys: 0, components: 0, uptime: 99.9 });
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    // Seed initial activities
    const initial: Activity[] = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      action: randomItem(ACTIONS),
      target: randomItem(TARGETS),
      time: timeAgo((5 - i) * 47 + 10),
      status: i === 0 ? 'pending' : Math.random() > 0.1 ? 'success' : 'error',
    }));
    setActivities(initial);
    setStats({ deploys: 12, components: 48, uptime: 99.9 });
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setPulse(true);
      setTimeout(() => setPulse(false), 600);

      setActivities((prev) => {
        const next: Activity = {
          id: Date.now(),
          action: randomItem(ACTIONS),
          target: randomItem(TARGETS),
          time: 'just now',
          status: Math.random() > 0.15 ? 'success' : Math.random() > 0.5 ? 'pending' : 'error',
        };
        return [next, ...prev.slice(0, 7)];
      });

      setStats((s) => ({
        deploys: s.deploys + 1,
        components: s.components + Math.floor(Math.random() * 3),
        uptime: Math.min(100, +(s.uptime + (Math.random() - 0.3) * 0.01).toFixed(1)),
      }));
    }, 4000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <div className={`dot ${pulse ? 'pulse' : ''}`} />
          <h1>Pulse</h1>
        </div>
        <span className="subtitle">Deployment Activity</span>
      </header>

      <div className="stats">
        <div className="stat-card">
          <span className="stat-value">{stats.deploys}</span>
          <span className="stat-label">Deploys</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.components}</span>
          <span className="stat-label">Components</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.uptime}%</span>
          <span className="stat-label">Uptime</span>
        </div>
      </div>

      <div className="feed">
        <h2>Activity Feed</h2>
        <ul>
          {activities.map((a) => (
            <li key={a.id} className={`activity ${a.status}`}>
              <div className={`status-dot ${a.status}`} />
              <div className="activity-body">
                <strong>{a.action}</strong> {a.target}
                <span className="time">{a.time}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
