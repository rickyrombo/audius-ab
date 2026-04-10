import { Link } from 'react-router-dom'

const features = [
  {
    title: 'Stereo Field Monitoring',
    desc: 'Keep your mix in check with a comprehensive stereo vectorscope and correlation meter.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="4" />
        <line x1="12" y1="2" x2="12" y2="6" />
        <line x1="12" y1="18" x2="12" y2="22" />
        <line x1="2" y1="12" x2="6" y2="12" />
        <line x1="18" y1="12" x2="22" y2="12" />
      </svg>
    ),
  },
  {
    title: 'Real-Time Spectrum Analyzer',
    desc: 'Visualize frequency balance across both tracks in real-time. Identify issues effortlessly.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="12" width="4" height="9" rx="1" />
        <rect x="10" y="5" width="4" height="16" rx="1" />
        <rect x="17" y="8" width="4" height="13" rx="1" />
      </svg>
    ),
  },
  {
    title: 'Time-Stamped Comments',
    desc: 'Receive precision feedback locked to the timeline. Know exactly when a comment occurs during the drop or verse.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <circle cx="12" cy="10" r="1" fill="currentColor" />
        <circle cx="8" cy="10" r="1" fill="currentColor" />
        <circle cx="16" cy="10" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: 'Loudness Analytics',
    desc: 'Integrated Short-Term LUFS, True Peak, and RMS metering to ensure your masters hit the mark.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20v-6M6 20v-4M18 20v-8M6 16a6 6 0 0 1 12 0" />
        <circle cx="12" cy="8" r="2" />
      </svg>
    ),
  },
  {
    title: 'True Blind Testing',
    desc: 'Hide track names to remove listener bias entirely. Find out which mix translates best, purely on sound.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    ),
  },
]

const audiences = [
  {
    title: 'Producers & Artists',
    desc: 'Stuck choosing between two different drops? Upload both and let your most trusted friends vote. Discover what truly resonates.',
    icon: '/landing/icon-producers.svg',
  },
  {
    title: 'Mixing Engineers',
    desc: 'Stop sending multiple Dropbox links. Compile your vocal up, instrumental, and radio mixes in one place for faster client sign-off.',
    icon: '/landing/icon-mixing.svg',
  },
  {
    title: 'Mastering Engineers',
    desc: 'Provide an objective comparison between your master and a reference track. Use built-in metering to explain your decisions.',
    icon: '/landing/icon-mastering.svg',
  },
]

export default function LandingPage() {
  return (
    <div className="landing">
      {/* ── Hero ── */}
      <section className="landing-hero">
        <img src="/landing/hero-bg.png" alt="" className="landing-hero-bg" />
        <div className="landing-container landing-hero-inner">
          <img src="/landing/logo.svg" alt="Audius A/B" className="landing-logo" />
          <h1 className="landing-headline">
            The Ultimate Reference Tool for Audio Creators
          </h1>
          <div className="landing-hero-content">
            <div className="landing-hero-text">
              <p className="landing-subtext">
                Compare tracks side-by-side, analyze audio in real-time, and get
                actionable feedback from your listeners. Take the guesswork out
                of your mastering and mixing decisions.
              </p>
              <div className="landing-cta-row">
                <Link to="/create" className="landing-btn landing-btn-primary">
                  Get Started
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="10" x2="16" y2="10" />
                    <polyline points="10 4 16 10 10 16" />
                  </svg>
                </Link>
                <Link to="/projects" className="landing-btn landing-btn-secondary">
                  Examples
                </Link>
              </div>
            </div>
            <div className="landing-hero-screenshot">
              <img src="/landing/screenshot.png" alt="Audius A/B interface" />
            </div>
          </div>
        </div>
      </section>

      {/* ── About ── */}
      <section className="landing-section landing-about">
        <div className="landing-container">
          <h2 className="landing-section-title">What is Audius A/B?</h2>
          <p className="landing-section-desc">
            Audius A/B is a purpose-built platform designed to solve the age-old
            problem of track referencing and client feedback. It gives producers
            and engineers an objective, data-driven way to compare multiple
            versions of a track.
          </p>
          <div className="landing-cards">
            <div className="landing-card">
              <div className="landing-card-icon">
                <img src="/landing/icon-feedback.svg" alt="" />
              </div>
              <h3>Contextual Feedback</h3>
              <p>
                Stop relying on subjective descriptions. Listeners can pinpoint
                exactly what works or doesn't at specific moments.
              </p>
            </div>
            <div className="landing-card">
              <div className="landing-card-icon">
                <img src="/landing/icon-analysis.svg" alt="" />
              </div>
              <h3>Side-by-Side Analysis</h3>
              <p>
                Seamlessly switch between two tracks without leaving the
                interface. Hear mix tweaks and master differences instantly.
              </p>
            </div>
            <div className="landing-card">
              <div className="landing-card-icon">
                <img src="/landing/icon-collab.svg" alt="" />
              </div>
              <h3>Private Collaboration</h3>
              <p>
                Generate private links to share your work with collaborators,
                clients, or test audiences.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="landing-section landing-features">
        <img src="/landing/hero-bg.png" alt="" className="landing-hero-bg" />
        <div className="landing-container">
          <div className="landing-features-grid">
            <div className="landing-features-heading">
              <h2>Powerful Audio Analytics</h2>
              <p>
                Beyond simple playback. Includes a complete suite of diagnostic
                tools directly in the browser so your listeners can give
                informed, actionable feedback.
              </p>
            </div>
            {features.map((f) => (
              <div className="landing-feature" key={f.title}>
                <div className="landing-feature-icon">{f.icon}</div>
                <div className="landing-feature-text">
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Audience ── */}
      <section className="landing-section landing-audience">
        <div className="landing-container">
          <h2 className="landing-section-title">Built for the Studio</h2>
          <p className="landing-section-desc">
            Whether you are making critical mixing decisions or seeing what
            sticks with listeners, Audius A/B provides the context you need.
          </p>
          <div className="landing-cards">
            {audiences.map((a) => (
              <div className="landing-card" key={a.title}>
                <div className="landing-card-icon">
                  <img src={a.icon} alt="" />
                </div>
                <h3>{a.title}</h3>
                <p>{a.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="landing-footer">
        <div className="landing-container landing-footer-inner">
          <p className="landing-footer-text">
            The ultimate A/B testing tool for audio creators. Compare, analyze,
            and get actionable feedback.
          </p>
          <img src="/landing/logo.svg" alt="Audius A/B" className="landing-footer-logo" />
        </div>
      </footer>
    </div>
  )
}
