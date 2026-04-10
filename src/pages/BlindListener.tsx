import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useSyncedWaveforms } from "../hooks/useSyncedWaveforms";
import { useHotkeys } from "../hooks/useHotkeys";
import { usePlaylistTracks } from "../hooks/usePlaylistTracks";
import { getStreamUrls } from "../lib/streamUrl";
import type { TrackSource } from "../lib/waveforms";
import type { Track } from "@audius/sdk";
import { useAuth } from "../hooks/useAuth";
import { useBlindSubmit } from "../hooks/useBlindSubmit";
import { useBackgroundVisualizer } from "../contexts/BackgroundVisualizerContext";
import { formatTime } from "../lib/utils";

export default function BlindListener() {
  const { playlistId } = useParams<{ playlistId: string }>();
  const navigate = useNavigate();

  const { data: playlist, error: queryError } = usePlaylistTracks(playlistId);
  const tracks = playlist?.tracks ?? [];
  const description = (playlist?.description ?? "").replace(/Made with Audius A\/B/g, "").trim();
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [preference, setPreference] = useState<"A" | "B" | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [showHelp, setShowHelp] = useState(() => !localStorage.getItem('helpDismissed:blind'));
  const dismissHelp = () => { localStorage.setItem('helpDismissed:blind', '1'); setShowHelp(false); };
  const ownerName = playlist?.user?.name || playlist?.user?.handle || null;

  // Dynamic page title
  useEffect(() => {
    const name = playlist?.playlistName || "Blind Test";
    document.title = `${name} — Blind Test — Audius A/B`;
    return () => { document.title = "Audius A/B — Compare Audio Mixes Side by Side"; };
  }, [playlist?.playlistName]);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const [showLoading, setShowLoading] = useState(false);

  const { currentUserHandle, checkAuth, ensureUser, logout } = useAuth();
  const [loginError, setLoginError] = useState<string | null>(null);

  // Randomize track order on mount — stable for the session
  const [shuffleMap] = useState<[number, number]>(() =>
    Math.random() < 0.5 ? [0, 1] : [1, 0]
  );

  const waveformSources: TrackSource[] = useMemo(
    () => {
      const ordered = tracks.length === 2
        ? [tracks[shuffleMap[0]], tracks[shuffleMap[1]]]
        : tracks;
      return ordered.map((t) => ({
        type: 'url' as const,
        urls: getStreamUrls(t.stream),
        trackId: t.id,
      }));
    },
    [tracks, shuffleMap]
  );

  const {
    isReady,
    loadError: waveformError,
    currentTime,
    duration,
    bpms,
    play,
    pause,
    seek,
    setActive,
    syncedRef,
  } = useSyncedWaveforms(waveformSources, undefined, () => {
    setIsPlaying(false);
  });

  const loadError = waveformError ?? (queryError?.message ?? null);

  // Delay showing loading modal by 1s
  useEffect(() => {
    if (tracks.length && isReady) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), 1000);
    return () => clearTimeout(timer);
  }, [tracks.length, isReady]);

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Sync playback state to background visualizer
  const bgViz = useBackgroundVisualizer();
  useEffect(() => {
    bgViz.setIsPlaying(isPlaying);
    bgViz.setBpm(bpms[activeIndex] ?? 120);
  }, [isPlaying, bpms, activeIndex, bgViz]);

  useHotkeys({
    activeIndex,
    isPlaying,
    duration,
    currentTime,
    bpms,
    trackCount: 2,
    syncedRef,
    seek,
    play,
    pause,
    setIsPlaying,
    onToggleTrack: handleToggle,
  });

  function handlePlayPause() {
    if (isPlaying) {
      pause();
      setIsPlaying(false);
    } else {
      play();
      setIsPlaying(true);
    }
  }

  function handleToggle(i: number) {
    setActiveIndex(i);
    setActive(i);
  }

  function handlePreference(choice: "A" | "B") {
    setPreference(choice);
  }

  const submitMutation = useBlindSubmit(ensureUser, currentUserHandle, {
    onSubmit: () => {
      setShowLoginPrompt(false);
      setRevealed(true);
    },
    onError: () => {
      setRevealed(false);
    },
  });

  function handleSubmitPreference() {
    if (!preference) return;
    const chosenIdx = preference === "A" ? 0 : 1;
    const chosenTrack = realTrack(chosenIdx);
    if (!chosenTrack) {
      setRevealed(true);
      return;
    }

    if (!currentUserHandle) {
      setShowLoginPrompt(true);
      return;
    }

    submitMutation.mutate({ chosenTrack, reason: reasonText.trim() });
  }

  function handleLoginAndSubmit() {
    if (!preference) return;
    const chosenIdx = preference === "A" ? 0 : 1;
    const chosenTrack = realTrack(chosenIdx);
    if (!chosenTrack) return;
    submitMutation.mutate({ chosenTrack, reason: reasonText.trim() });
  }

  function handleSkipLogin() {
    setShowLoginPrompt(false);
    setRevealed(true);
  }

  // Map blind label back to real track
  function realTrack(blindIdx: number): Track | null {
    if (tracks.length < 2) return null;
    return tracks[shuffleMap[blindIdx]];
  }

  if (loadError) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Audius AB</h1>
        </div>
        <p className="status-msg error">Error: {loadError}</p>
      </div>
    );
  }

  if (!playlist) {
    if (!showLoading) return null;
    return (
      <div className="modal-overlay">
        <div className="modal loading-modal">
          <div className="spinner" />
          <p>Loading blind A/B test…</p>
        </div>
      </div>
    );
  }

  if (tracks.length < 2) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Audius AB</h1>
        </div>
        <p className="status-msg error">
          This project needs at least 2 tracks for a blind test.
        </p>
        <Link to={`/analyze/${playlistId}`} className="btn-primary" style={{ alignSelf: 'flex-start' }}>
          Open in analyzer
        </Link>
      </div>
    );
  }

  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div className="page blind-page">
      {!isReady && showLoading && (
        <div className="modal-overlay">
          <div className="modal loading-modal">
            <div className="spinner" />
            <p>Preparing blind A/B test...</p>
          </div>
        </div>
      )}

      <div className="blind-top-bar">
        <div className="header-actions">
          <button
            type="button"
            className="btn-header btn-header-text"
            onClick={() => navigate("/analyze")}
            title="Create new AB test"
          >
            + New Project
          </button>
          <Link to="/projects" className="btn-header btn-header-text" title="My projects">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Projects
          </Link>
          <button
            type="button"
            className="btn-header"
            onClick={() => setShowHelp(true)}
            title="Help"
          >
            ?
          </button>
          {currentUserHandle ? (
            <>
              <Link to="/projects" className="user-handle-text">@{currentUserHandle}</Link>
              <button
                type="button"
                className="btn-header btn-logout"
                onClick={() => {
                  logout().catch(() => {});
                }}
                title="Log out"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-header btn-header-text"
              onClick={() => {
                setLoginError(null);
                ensureUser().catch(() =>
                  setLoginError("Login failed. Please try again.")
                );
              }}
              title="Log in with Audius"
            >
              Log in
            </button>
          )}
          {loginError && <span className="status-msg error">{loginError}</span>}
        </div>
      </div>

      <div className="blind-content">
        <div className="blind-header">
          <h1>Blind A/B Test</h1>
          {description && <p className="blind-question">{description}</p>}
          {!revealed && (
            <p className="blind-hint">
              Listen with your ears only. Which do you prefer?
            </p>
          )}
        </div>

        {/* Track toggle */}
        <div className="blind-toggle">
          <button
            type="button"
            className={`blind-track-btn${activeIndex === 0 ? " active" : ""}`}
            onClick={() => handleToggle(0)}
          >
            A
          </button>
          <button
            type="button"
            className={`blind-track-btn${activeIndex === 1 ? " active" : ""}`}
            onClick={() => handleToggle(1)}
          >
            B
          </button>
        </div>

        {/* Transport controls */}
        <div className="blind-transport">
          <div className="blind-play-row">
            <button
              type="button"
              className="btn-playpause blind-seek-btn"
              onClick={() => {
                if (duration <= 0) return;
                const cur = syncedRef.current?.getCurrentTime() ?? currentTime;
                seek(Math.max(0, cur - 10) / duration);
              }}
              disabled={!isReady}
              title="Back 10s"
            >
              ↺
            </button>
            <button
              type="button"
              className="btn-playpause blind-play"
              onClick={handlePlayPause}
              disabled={!isReady}
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
            <button
              type="button"
              className="btn-playpause blind-seek-btn"
              onClick={() => {
                if (duration <= 0) return;
                const cur = syncedRef.current?.getCurrentTime() ?? currentTime;
                seek(Math.min(duration, cur + 10) / duration);
              }}
              disabled={!isReady}
              title="Forward 10s"
            >
              ↻
            </button>
          </div>
          <div className="blind-seek-row">
            <span className="blind-time">{formatTime(currentTime)}</span>
            <div
              className="blind-progress-bar"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const p = Math.max(
                  0,
                  Math.min(1, (e.clientX - rect.left) / rect.width)
                );
                seek(p);
              }}
            >
              <div
                className="blind-progress-fill"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <span className="blind-time">{formatTime(duration)}</span>
          </div>
        </div>

        {/* Preference / Reveal */}
        {tracks.length >= 2 && !revealed && (
          <div className="blind-preference">
            {!preference ? (
              <>
                <p>I prefer:</p>
                <div className="blind-preference-btns">
                  <button
                    type="button"
                    className="blind-pref-btn"
                    onClick={() => handlePreference("A")}
                  >
                    A
                  </button>
                  <button
                    type="button"
                    className="blind-pref-btn"
                    onClick={() => handlePreference("B")}
                  >
                    B
                  </button>
                </div>
              </>
            ) : (
              <div className="blind-reason">
                <p>
                  You chose <strong>{preference}</strong>. Why?
                </p>
                <textarea
                  className="blind-reason-input"
                  placeholder="What stood out? (optional)"
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  rows={2}
                  disabled={submitMutation.isPending}
                />
                <div className="blind-reason-actions">
                  <button
                    type="button"
                    className="blind-pref-btn blind-skip-btn"
                    onClick={() => {
                      setPreference(null);
                    }}
                    disabled={submitMutation.isPending}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="blind-pref-btn blind-submit-btn"
                    onClick={handleSubmitPreference}
                    disabled={submitMutation.isPending}
                  >
                    {submitMutation.isPending ? "Submitting..." : "Reveal"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {revealed && preference && (
          <div className="blind-reveal">
            <div className="blind-reveal-header">You chose {preference}!</div>
            <div className="blind-reveal-grid">
              <div
                className={`blind-reveal-card${
                  preference === "A" ? " chosen" : ""
                }`}
              >
                <div className="blind-reveal-label">A was:</div>
                <div className="blind-reveal-title">{realTrack(0)?.title}</div>
                <div className="blind-reveal-artist">
                  {realTrack(0)?.user?.name || realTrack(0)?.user?.handle}
                </div>
              </div>
              <div
                className={`blind-reveal-card${
                  preference === "B" ? " chosen" : ""
                }`}
              >
                <div className="blind-reveal-label">B was:</div>
                <div className="blind-reveal-title">{realTrack(1)?.title}</div>
                <div className="blind-reveal-artist">
                  {realTrack(1)?.user?.name || realTrack(1)?.user?.handle}
                </div>
              </div>
            </div>
            <button
              type="button"
              className="btn-secondary blind-compare-btn"
              onClick={() => navigate(`/analyze/${playlistId}`)}
            >
              Open full analysis
            </button>
          </div>
        )}
      </div>

      {showLoginPrompt && (
        <div
          className="modal-overlay"
          onClick={() => setShowLoginPrompt(false)}
        >
          <div
            className="modal modal-narrow"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close"
              onClick={() => setShowLoginPrompt(false)}
            >
              ✕
            </button>
            <h2>Log in to share your result</h2>
            <p>
              Log in to automatically favorite your pick
              {ownerName
                ? ` and let ${ownerName} know`
                : " and let the creator know"}{" "}
              which one you chose
              {reasonText.trim() ? " along with your feedback" : ""}.
            </p>
            <div className="blind-login-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={handleLoginAndSubmit}
              >
                Log in with Audius
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleSkipLogin}
              >
                Skip — I'll tell them myself
              </button>
            </div>
          </div>
        </div>
      )}

      {showHelp && (
        <div className="modal-overlay" onClick={() => dismissHelp()}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="modal-close"
              onClick={() => dismissHelp()}
            >
              ✕
            </button>
            <h2>Blind A/B Test</h2>
            <p>
              Listen to two tracks without any visual cues and pick the one you
              prefer. Your choice will be favorited and your reasoning posted as
              a comment.
            </p>

            <h3>How to use</h3>
            <ul>
              <li>
                Press play or hit <kbd>Space</kbd> to start playback
              </li>
              <li>Switch between A and B to compare</li>
              <li>Click the seek bar to jump to a position</li>
              <li>
                When ready, choose which you prefer and optionally explain why
              </li>
              <li>After submitting, the real track names are revealed</li>
            </ul>

            <h3>Hotkeys</h3>
            <table className="hotkeys-table">
              <tbody>
                <tr>
                  <td>
                    <kbd>Space</kbd>
                  </td>
                  <td>Play / Pause</td>
                </tr>
                <tr>
                  <td>
                    <kbd>1</kbd> / <kbd>2</kbd>
                  </td>
                  <td>Switch to A / B</td>
                </tr>
                <tr>
                  <td>
                    <kbd>↑</kbd> / <kbd>↓</kbd>
                  </td>
                  <td>Switch track</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
