import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getSDK } from "../lib/audius";
import { useSyncedWaveforms } from "../hooks/useSyncedWaveforms";
import { useAuth } from "../hooks/useAuth";
import { useBlindSubmit } from "../hooks/useBlindSubmit";
import { useBackgroundVisualizer } from "../contexts/BackgroundVisualizerContext";

interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  streamUrl: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function BlindListener() {
  const { playlistId } = useParams<{ playlistId: string }>();
  const navigate = useNavigate();

  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [, setPlaylistName] = useState("");
  const [description, setDescription] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [preference, setPreference] = useState<"A" | "B" | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [ownerName, setOwnerName] = useState<string | null>(null);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const [showLoading, setShowLoading] = useState(false);

  const { currentUserHandle, checkAuth, ensureUser, logout } = useAuth();

  // Randomize track order on mount — stable for the session
  const [shuffleMap] = useState<[number, number]>(() =>
    Math.random() < 0.5 ? [0, 1] : [1, 0]
  );

  const streamUrls = useMemo(
    () =>
      tracks.length === 2
        ? [tracks[shuffleMap[0]].streamUrl, tracks[shuffleMap[1]].streamUrl]
        : tracks.map((t) => t.streamUrl),
    [tracks, shuffleMap]
  );
  const trackIds = useMemo(
    () =>
      tracks.length === 2
        ? [tracks[shuffleMap[0]].id, tracks[shuffleMap[1]].id]
        : tracks.map((t) => t.id),
    [tracks, shuffleMap]
  );

  const {
    isReady,
    currentTime,
    duration,
    bpms,
    play,
    pause,
    seek,
    setActive,
    syncedRef,
  } = useSyncedWaveforms(streamUrls, trackIds, undefined, () => {
    setIsPlaying(false);
  });

  // Delay showing loading modal by 1s
  useEffect(() => {
    if (tracks.length && isReady) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), 1000);
    return () => clearTimeout(timer);
  }, [tracks.length, isReady]);

  // Load playlist
  useEffect(() => {
    if (!playlistId) return;
    const sdk = getSDK();
    let cancelled = false;

    async function load() {
      try {
        const playlistResp = await sdk.playlists.getPlaylist({
          playlistId: playlistId!,
        });
        const playlist = playlistResp.data?.[0];
        if (!playlist) throw new Error("Playlist not found");
        if (cancelled) return;

        setDescription(playlist.description ?? "");
        if (playlist.user) {
          setOwnerName(playlist.user.name || playlist.user.handle || null);
        }

        const ids: string[] = playlist.playlistContents
          .map((c) => c.trackId)
          .filter(Boolean);
        if (!ids.length) throw new Error("No tracks in playlist");
        if (cancelled) return;

        const bulkResp = await sdk.tracks.getBulkTracks({ id: ids });
        const bulkTracks = bulkResp.data ?? [];
        const trackInfos: TrackInfo[] = ids
          .map((id) => {
            const t = bulkTracks.find((bt) => bt.id === id);
            if (!t) return null;
            return {
              id: t.id,
              title: t.title,
              artist: t.user?.name || t.user?.handle || "",
              streamUrl: t.stream?.url ?? t.stream?.mirrors?.[0] ?? "",
            };
          })
          .filter((t): t is TrackInfo => t !== null);

        setPlaylistName(playlist.playlistName || "Blind Test");
        if (!cancelled) setTracks(trackInfos);
      } catch (err) {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : "Failed to load");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [playlistId]);

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

  // Refs for hotkey handlers to avoid stale closures
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const playRef = useRef(play);
  playRef.current = play;
  const bpmsRef = useRef(bpms);
  bpmsRef.current = bpms;
  const pauseRef = useRef(pause);
  pauseRef.current = pause;

  // Hotkeys
  useEffect(() => {
    const FINE_NUDGE_SECS = 0.5;

    function fourBeatsSecs(): number {
      const bpm = bpmsRef.current[activeIndexRef.current] || 120;
      return (60 / bpm) * 4;
    }
    const FF_INTERVAL_MS = 80;
    const FF_SECS_PER_TICK = 0.5;
    const HOLD_THRESHOLD_MS = 300;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let ffInterval: ReturnType<typeof setInterval> | null = null;
    let didHold = false;
    let wasShiftSeek = false;

    function seekRelative(deltaSecs: number) {
      const dur = durationRef.current;
      if (dur <= 0) return;
      const cur = syncedRef.current?.getCurrentTime() ?? currentTimeRef.current;
      const newTime = Math.max(0, Math.min(dur, cur + deltaSecs));
      seekRef.current?.(newTime / dur);
    }

    const FF_SHIFT_MULTIPLIER = 4;
    let shiftHeld = false;

    function startFastSeek(dir: number) {
      if (ffInterval) return;
      didHold = true;
      ffInterval = setInterval(() => {
        seekRelative(
          dir * FF_SECS_PER_TICK * (shiftHeld ? FF_SHIFT_MULTIPLIER : 1)
        );
      }, FF_INTERVAL_MS);
    }

    function stopFastSeek() {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (ffInterval) {
        clearInterval(ffInterval);
        ffInterval = null;
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Shift") {
        shiftHeld = true;
        return;
      }
      if (
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement
      )
        return;

      if (e.key === " ") {
        e.preventDefault();
        if (isPlayingRef.current) {
          pauseRef.current?.();
          setIsPlaying(false);
        } else {
          playRef.current?.();
          setIsPlaying(true);
        }
        return;
      }

      const numIdx = ["1", "2"].indexOf(e.key);
      if (numIdx !== -1) {
        handleToggle(numIdx);
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        handleToggle(0);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        handleToggle(1);
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (e.repeat) return;
        didHold = false;
        wasShiftSeek = e.shiftKey;
        shiftHeld = e.shiftKey;
        holdTimer = setTimeout(() => startFastSeek(dir), HOLD_THRESHOLD_MS);
        return;
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.key === "Shift") {
        shiftHeld = false;
        return;
      }
      if (
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement
      )
        return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const dir = e.key === "ArrowRight" ? 1 : -1;
        stopFastSeek();
        if (!didHold) {
          if (wasShiftSeek) {
            seekRelative(dir * fourBeatsSecs());
          } else {
            seekRelative(dir * FINE_NUDGE_SECS);
          }
        }
        didHold = false;
        wasShiftSeek = false;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      stopFastSeek();
    };
  }, [tracks]);

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
  function realTrack(blindIdx: number): TrackInfo | null {
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

  if (!tracks.length) {
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
            className="btn-header btn-login"
            onClick={() => navigate("/")}
            title="Create new AB test"
          >
            + New
          </button>
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
              <span className="user-handle-text">@{currentUserHandle}</span>
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
              className="btn-header btn-login"
              onClick={() => {
                ensureUser().catch((err) =>
                  console.error("Login failed:", err)
                );
              }}
              title="Log in with Audius"
            >
              Log in
            </button>
          )}
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
          <button
            type="button"
            className="btn-playpause blind-play"
            onClick={handlePlayPause}
            disabled={!isReady}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
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
                  {realTrack(0)?.artist}
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
                  {realTrack(1)?.artist}
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
        <div className="modal-overlay" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="modal-close"
              onClick={() => setShowHelp(false)}
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
