import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './components/Icon';
import { REPO_URL, repoLink } from './lib/data';
import { hrefFor, useRoute, type Route } from './lib/router';
import { Compose } from './pages/Compose';
import { Errors } from './pages/Errors';
import { Evidence } from './pages/Evidence';
import { Inspect } from './pages/Inspect';
import { Overview } from './pages/Overview';
import { Verify } from './pages/Verify';
import { Vectors } from './pages/Vectors';

interface NavItem {
  route: Route;
  label: string;
  icon: IconName;
}

const NAV: { group?: string; items: NavItem[] }[] = [
  { items: [{ route: 'overview', label: 'Overview', icon: 'overview' }] },
  {
    group: 'Work with a claim',
    items: [
      { route: 'compose', label: 'Compose & sign', icon: 'compose' },
      { route: 'verify', label: 'Verify', icon: 'verify' },
      { route: 'inspect', label: 'Inspect & diff', icon: 'inspect' },
    ],
  },
  {
    group: 'Reference',
    items: [
      { route: 'vectors', label: 'Test vectors', icon: 'vectors' },
      { route: 'errors', label: 'Error codes', icon: 'errors' },
      { route: 'evidence', label: 'Testnet evidence', icon: 'evidence' },
    ],
  },
];

const PAGES: Record<Route, () => ReactNode> = {
  overview: () => <Overview />,
  compose: () => <Compose />,
  verify: () => <Verify />,
  inspect: () => <Inspect />,
  vectors: () => <Vectors />,
  errors: () => <Errors />,
  evidence: () => <Evidence />,
};

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('coreflow-workbench-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem('coreflow-workbench-theme');
      else localStorage.setItem('coreflow-workbench-theme', theme);
    } catch {
      // Storage can be unavailable (private windows, blocked site data); the theme still applies.
    }
  }, [theme]);
  return [theme, setTheme];
}

export function App() {
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  useEffect(() => {
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  }, [route]);

  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="sidebar-top">
          <a className="brand" href={hrefFor('overview')}>
            <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="#1e3a8a" />
              <path d="M9 11.5h14M9 16h9M9 20.5h14" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
              <circle cx="22.5" cy="16" r="2.2" fill="#93c5fd" />
            </svg>
            <span className="brand-name">
              CoreFlow Kit
              <span className="brand-sub">Workbench</span>
            </span>
          </a>
          <button
            type="button"
            className="btn btn-sm menu-button"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Icon name="menu" />
            Menu
          </button>
        </div>
        <nav id="primary-nav" className="nav" aria-label="Workbench" data-open={menuOpen}>
          {NAV.map((section, i) => (
            <div key={i}>
              {section.group ? <p className="nav-group">{section.group}</p> : null}
              <ul>
                {section.items.map((item) => (
                  <li key={item.route}>
                    <a href={hrefFor(item.route)} aria-current={route === item.route ? 'page' : undefined}>
                      <Icon name={item.icon} className="nav-icon" />
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <p>
            <strong>0.1.0-alpha.</strong> Testnet only, not audited.
          </p>
          <p>Everything here runs in this browser tab. Nothing is sent to a server.</p>
          <p>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Repository
            </a>{' '}
            ·{' '}
            <a href={repoLink('docs/kit/claim-format.md')} target="_blank" rel="noreferrer">
              Claim format
            </a>
          </p>
          <div className="theme-switch" role="group" aria-label="Colour theme">
            {(['system', 'light', 'dark'] as Theme[]).map((t) => (
              <button
                key={t}
                type="button"
                className="btn btn-sm"
                aria-pressed={theme === t}
                onClick={() => setTheme(t)}
                style={theme === t ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
              >
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        <div key={route}>{PAGES[route]()}</div>
      </main>
    </div>
  );
}
