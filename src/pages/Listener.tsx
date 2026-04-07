import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useSyncedWaveforms } from "../hooks/useSyncedWaveforms";
import { useAuth } from "../hooks/useAuth";
import { useComments } from "../hooks/useComments";
import { usePostComment } from "../hooks/usePostComment";
import { useDeleteComment } from "../hooks/useDeleteComment";
import { useEditComment } from "../hooks/useEditComment";
import { useTracks } from "../hooks/useTracks";
import { useFavoriteTrack } from "../hooks/useFavoriteTrack";
import { useUnfavoriteTrack } from "../hooks/useUnfavoriteTrack";
import { usePlaylistTracks } from "../hooks/usePlaylistTracks";
import { getStreamUrls } from "../lib/streamUrl";
import SpectrumAnalyzer from "../components/SpectrumAnalyzer";
import SpaceAnalyzer from "../components/SpaceAnalyzer";
import VolumeIndicator from "../components/VolumeIndicator";
import RGBWaveform from "../components/RGBWaveform";
import ZoomedWaveform from "../components/ZoomedWaveform";
import { useBackgroundVisualizer } from "../contexts/BackgroundVisualizerContext";

const LABELS = ["A", "B"];

function AvatarImg({
  src,
  mirrors,
  alt,
}: {
  src: string;
  mirrors: string[];
  alt: string;
}) {
  const tryMirror = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const tried = parseInt(img.dataset.mirrorIdx ?? "0", 10);
    if (tried < mirrors.length) {
      img.dataset.mirrorIdx = String(tried + 1);
      img.src = mirrors[tried];
    }
  };
  return <img src={src} alt={alt} onError={tryMirror} />;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}


export default function Listener() {
  const { playlistId } = useParams<{ playlistId: string }>();
  const navigate = useNavigate();


  const { data: playlist, error: queryError } = usePlaylistTracks(playlistId);
  const tracks = playlist?.tracks ?? [];
  const playlistName = playlist?.playlistName || (
    tracks.length >= 2
      ? `Audius AB: ${tracks[0].title} vs ${tracks[1].title}`
      : tracks.length === 1
        ? `Audius AB: ${tracks[0].title}`
        : "Audius AB"
  );
  const description = (playlist?.description ?? "").replace(/Made with Audius A\/B/g, "").trim();
  const ownerId = playlist?.user?.id ?? null;
  const loadError = queryError?.message ?? null;
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentTrackIdx, setCommentTrackIdx] = useState(0);
  const [commentTime, setCommentTime] = useState<number | null>(null);

  const [showHelp, setShowHelp] = useState(() => !localStorage.getItem('helpDismissed:analyze'));
  const dismissHelp = () => { localStorage.setItem('helpDismissed:analyze', '1'); setShowHelp(false); };
  const [showOverlay, setShowOverlay] = useState(false);
  const [highlightedCommentId, setHighlightedCommentId] = useState<
    string | null
  >(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    commentId: string;
    trackId: string;
  } | null>(null);
  const [editingComment, setEditingComment] = useState<{
    id: string;
    trackId: string;
    body: string;
  } | null>(null);

  const [showLoading, setShowLoading] = useState(false);
  const [mobileAnalyzer, setMobileAnalyzer] = useState<"spectrum" | "space" | "volume">("spectrum");
  const [mobileAnalyzerTrack, setMobileAnalyzerTrack] = useState<"a" | "b" | "overlay">("a");
  const commentTextareaRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipFocusTimeRef = useRef(false);

  const { currentUserId, currentUserHandle, checkAuth, ensureUser, logout } =
    useAuth();
  const trackIds = tracks.map((t) => t.id);
  const allComments = useComments(trackIds, ownerId, currentUserId);
  const postComment = usePostComment(
    ensureUser,
    currentUserId,
    currentUserHandle
  );
  const deleteComment = useDeleteComment(ensureUser);
  const editComment = useEditComment(ensureUser);
  const trackQueries = useTracks(trackIds, currentUserId);
  const favoriteTrack = useFavoriteTrack(trackIds, ensureUser, currentUserId);
  const unfavoriteTrack = useUnfavoriteTrack(ensureUser, currentUserId);

  function toggleFavorite(trackId: string) {
    const isSaved =
      trackQueries[trackIds.indexOf(trackId)]?.data?.hasCurrentUserSaved;
    if (isSaved) {
      unfavoriteTrack.mutate(trackId);
    } else {
      const currentFav = trackIds.find(
        (_, i) => trackQueries[i]?.data?.hasCurrentUserSaved
      );
      if (currentFav) unfavoriteTrack.mutate(currentFav);
      favoriteTrack.mutate(trackId);
    }
  }

  const streamUrlSets = tracks.map((t) => getStreamUrls(t.stream));

  const {
    isReady,
    currentTime,
    duration,
    trackDurations,
    colorData,
    bpms,
    loudnessStats,
    play,
    pause,
    seek,
    setActive,
    syncedRef,
  } = useSyncedWaveforms(
    streamUrlSets,
    trackIds,
    (time) => {
      setCommentTime(time);
    },
    () => {
      setIsPlaying(false);
    }
  );

  // Delay showing loading modal by 1s
  useEffect(() => {
    if (tracks.length && isReady) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), 1000);
    return () => clearTimeout(timer);
  }, [tracks.length, isReady]);

  // Check if user is already logged in (don't force login)
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

    /** 4 beats in seconds based on active track's BPM */
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
      // Read real-time position from audio engine, not throttled React state
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
        const base = FF_SECS_PER_TICK;
        seekRelative(dir * base * (shiftHeld ? FF_SHIFT_MULTIPLIER : 1));
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

      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        const idx = activeIndexRef.current;
        setCommentTrackIdx(idx);
        setCommentTime(currentTimeRef.current);
        commentTextareaRefs.current[idx]?.focus();
        return;
      }

      const numIdx = ["1", "2"].indexOf(e.key);
      if (numIdx !== -1 && numIdx < tracks.length) {
        handleToggleTrack(numIdx);
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = Math.max(0, activeIndexRef.current - 1);
        if (prev !== activeIndexRef.current) handleToggleTrack(prev);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = Math.min(tracks.length - 1, activeIndexRef.current + 1);
        if (next !== activeIndexRef.current) handleToggleTrack(next);
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

  function handleToggleTrack(i: number) {
    setActiveIndex(i);
    setActive(i);
    setCommentTrackIdx(i);
  }

  function renderCommentForm(i: number) {
    // Only allow comments on tracks owned by the playlist creator
    if (!ownerId || !tracks[i] || tracks[i].userId !== ownerId) return null;
    return (
      <div className="comment-form">
        <textarea
          ref={(el) => {
            commentTextareaRefs.current[i] = el;
          }}
          rows={1}
          placeholder={
            tracks.length > 1 ? `Comment on ${LABELS[i]}…` : "Leave a comment…"
          }
          value={commentTrackIdx === i ? commentText : ""}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.blur();
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (commentTrackIdx === i && commentText.trim()) {
                handleComment();
              }
            }
          }}
          onFocus={() => {
            setCommentTrackIdx(i);
            if (skipFocusTimeRef.current) {
              skipFocusTimeRef.current = false;
            } else {
              setCommentTime(currentTime);
            }
          }}
          onChange={(e) => {
            setCommentTrackIdx(i);
            setCommentText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = e.target.scrollHeight + "px";
          }}
          onBlur={(e) => {
            if (!e.target.value.trim()) {
              setCommentTime(null);
              e.target.style.height = "";
            }
          }}
          disabled={postComment.isPending}
        />
        {commentTrackIdx === i && commentTime !== null && (
          <span className="comment-at-badge">{formatTime(commentTime)}</span>
        )}
        <button
          type="button"
          className="btn-comment"
          onClick={() => {
            setCommentTrackIdx(i);
            handleComment();
          }}
          disabled={
            !(commentTrackIdx === i && commentText.trim()) ||
            postComment.isPending
          }
        >
          {postComment.isPending && commentTrackIdx === i ? "Posting…" : "Post"}
        </button>
      </div>
    );
  }

  function handlePlayPause() {
    if (isPlaying) {
      pause();
      setIsPlaying(false);
    } else {
      play();
      setIsPlaying(true);
    }
  }

  function scrollToComment(commentId: string) {
    const el = document.getElementById(`comment-${commentId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedCommentId(commentId);
    setTimeout(() => setHighlightedCommentId(null), 2000);
  }

  function handleComment() {
    if (!commentText.trim() || !tracks.length) return;
    const trackId = tracks[commentTrackIdx]?.id;
    if (!trackId) return;
    postComment.mutate({
      trackId,
      body: commentText.trim(),
      timestampS: Math.floor(commentTime ?? currentTime),
    });
    setCommentText("");
    setCommentTime(null);
  }

  if (loadError) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>A/B Analysis</h1>
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
          <p>Loading playlist…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page listener-page">
      <div className="listener-above-fold">
        <div className="page-header">
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
          <div className="header-playback-row">
            <button
              type="button"
              className="btn-playpause btn-playpause-lg"
              onClick={handlePlayPause}
              disabled={!isReady}
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
            <div className="header-title-group">
              <h1>{playlistName}</h1>
              {description && (
                <span className="listener-question">{description}</span>
              )}
            </div>
          </div>
        </div>

        {!isReady && showLoading && (
          <div className="modal-overlay">
            <div className="modal loading-modal">
              <div className="spinner" />
              <p>Fetching and decoding audio…</p>
            </div>
          </div>
        )}

        {/* Analyzer overlay toggle */}
        {tracks.length > 1 && (
          <div className="analyzer-overlay-bar">
            <button
              type="button"
              className={`overlay-toggle${showOverlay ? " active" : ""}`}
              onClick={() => setShowOverlay((v) => !v)}
            >
              A/B Overlay
            </button>
          </div>
        )}

        {/* Mobile Analyzer (single panel with selector) */}
        <div className="mobile-analyzer">
          <div className="mobile-analyzer-selectors">
            <div className="mobile-analyzer-tabs">
              {(["spectrum", "space", "volume"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`mobile-analyzer-tab${mobileAnalyzer === type ? " active" : ""}`}
                  onClick={() => setMobileAnalyzer(type)}
                >
                  {type === "spectrum" ? "Spectrum" : type === "space" ? "Stereo" : "Loudness"}
                </button>
              ))}
            </div>
            {tracks.length > 1 && (
              <div className="mobile-analyzer-tabs">
                {(["a", "b", "overlay"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`mobile-analyzer-tab track-${t}${mobileAnalyzerTrack === t ? " active" : ""}`}
                    onClick={() => setMobileAnalyzerTrack(t)}
                  >
                    {t === "overlay" ? "A+B" : t.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={`mobile-analyzer-panel ${mobileAnalyzerTrack === "b" ? "track-b" : "track-a"}`}>
            {mobileAnalyzer === "spectrum" && (
              <SpectrumAnalyzer
                syncedRef={syncedRef}
                isPlaying={isPlaying}
                trackIndex={mobileAnalyzerTrack === "b" ? 1 : 0}
                accentColor={mobileAnalyzerTrack === "b" ? "#3080e0" : "#e06030"}
                otherAccentColor={mobileAnalyzerTrack === "b" ? "#e06030" : "#3080e0"}
                showOverlay={mobileAnalyzerTrack === "overlay"}
              />
            )}
            {mobileAnalyzer === "space" && (
              <SpaceAnalyzer
                syncedRef={syncedRef}
                isPlaying={isPlaying}
                trackIndex={mobileAnalyzerTrack === "b" ? 1 : 0}
                accentColor={mobileAnalyzerTrack === "b" ? "#3080e0" : "#e06030"}
                otherAccentColor={mobileAnalyzerTrack === "b" ? "#e06030" : "#3080e0"}
                showOverlay={mobileAnalyzerTrack === "overlay"}
              />
            )}
            {mobileAnalyzer === "volume" && (
              <VolumeIndicator
                syncedRef={syncedRef}
                isPlaying={isPlaying}
                trackIndex={mobileAnalyzerTrack === "b" ? 1 : 0}
                accentColor={mobileAnalyzerTrack === "b" ? "#3080e0" : "#e06030"}
                otherAccentColor={mobileAnalyzerTrack === "b" ? "#e06030" : "#3080e0"}
                showOverlay={mobileAnalyzerTrack === "overlay"}
                loudnessStats={loudnessStats[mobileAnalyzerTrack === "b" ? 1 : 0]}
              />
            )}
          </div>
        </div>

        {/* Track A Analyzers (desktop) */}
        <div className="analyzers-row track-a">
          <SpectrumAnalyzer
            syncedRef={syncedRef}
            isPlaying={isPlaying}
            trackIndex={0}
            accentColor="#e06030"
            otherAccentColor="#3080e0"
            showOverlay={showOverlay}
          />
          <SpaceAnalyzer
            syncedRef={syncedRef}
            isPlaying={isPlaying}
            trackIndex={0}
            accentColor="#e06030"
            otherAccentColor="#3080e0"
            showOverlay={showOverlay}
          />
          <VolumeIndicator
            syncedRef={syncedRef}
            isPlaying={isPlaying}
            trackIndex={0}
            accentColor="#e06030"
            otherAccentColor="#3080e0"
            showOverlay={showOverlay}
            loudnessStats={loudnessStats[0]}
          />
        </div>

        {/* Waveform area */}
        <div className="waveform-area">
          <div className="waveform-area-center">
            {/* Track A */}
            {tracks.length > 0 && (
              <div className="waveform-track-group">
                {renderCommentForm(0)}
                <div className="waveform-time-row">
                  {tracks.length > 1 && (
                    <div className="time-row-spacer-toggle" />
                  )}
                  <div className="comment-avatars-strip">
                    {(allComments[0] ?? []).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="comment-avatar-marker"
                        style={{
                          left:
                            duration > 0
                              ? `${(c.timestampSeconds / duration) * 100}%`
                              : "0%",
                        }}
                        title={`@${c.handle}: ${c.body}`}
                        onClick={() => scrollToComment(c.id)}
                      >
                        {c.avatarUrl ? (
                          <AvatarImg
                            src={c.avatarUrl}
                            mirrors={c.avatarMirrors}
                            alt=""
                          />
                        ) : (
                          <span className="comment-avatar-fallback">
                            {c.handle[0]?.toUpperCase()}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="time-row-spacer-right">
                    <span className="time-display">
                      {formatTime(
                        Math.min(currentTime, trackDurations[0] ?? duration)
                      )}{" "}
                      / {formatTime(trackDurations[0] ?? duration)}
                    </span>
                  </div>
                </div>
                <div
                  className={`waveform-row track-a${
                    activeIndex === 0 ? " active" : ""
                  }`}
                >
                  {tracks.length > 1 && (
                    <button
                      type="button"
                      className={`track-toggle-btn track-a${
                        activeIndex === 0 ? " active" : ""
                      }`}
                      onClick={() => handleToggleTrack(0)}
                      title={`Listen to ${tracks[0].title || "track A"}`}
                    >
                      A
                    </button>
                  )}
                  <RGBWaveform
                    syncedRef={syncedRef}
                    colorData={colorData[0] ?? null}
                    duration={duration}
                    trackDuration={trackDurations[0] ?? duration}
                    isActive={activeIndex === 0}
                    activeColor="#e06030"
                    onClick={(progress) => {
                      if (clickTimerRef.current)
                        clearTimeout(clickTimerRef.current);
                      clickTimerRef.current = setTimeout(() => {
                        clickTimerRef.current = null;
                        handleToggleTrack(0);
                        if (duration > 0) seek(progress);
                      }, 250);
                    }}
                    onDoubleClick={(progress) => {
                      if (clickTimerRef.current) {
                        clearTimeout(clickTimerRef.current);
                        clickTimerRef.current = null;
                      }
                      handleToggleTrack(0);
                      if (ownerId && tracks[0]?.userId === ownerId) {
                        setCommentTime(progress * duration);
                        skipFocusTimeRef.current = true;
                        commentTextareaRefs.current[0]?.focus();
                      }
                    }}
                  >
                    <div
                      className="comment-marker pending"
                      style={{
                        left:
                          duration > 0 && commentTime !== null
                            ? `${(commentTime / duration) * 100}%`
                            : "0%",
                        display:
                          commentTime !== null && commentTrackIdx === 0
                            ? undefined
                            : "none",
                      }}
                    />
                  </RGBWaveform>
                  <div className="waveform-container waveform-zoomed-side">
                    <ZoomedWaveform
                      syncedRef={syncedRef}
                      colorData={colorData[0] ?? null}
                      trackIndex={0}
                    />
                  </div>
                  <button
                    type="button"
                    className={`btn-favorite${
                      trackQueries[0]?.data?.hasCurrentUserSaved
                        ? " favorited"
                        : ""
                    }`}
                    onClick={() => toggleFavorite(tracks[0].id)}
                    title={
                      trackQueries[0]?.data?.hasCurrentUserSaved
                        ? "Unfavorite this track"
                        : "Favorite this track"
                    }
                  >
                    ♥
                  </button>
                </div>
              </div>
            )}

            {/* Mobile zoomed waveforms (between overview waveforms) */}
            {tracks.length > 0 && (
              <div className="mobile-zoomed-waveforms">
                <div className="mobile-zoomed-track">
                  <ZoomedWaveform
                    syncedRef={syncedRef}
                    colorData={colorData[0] ?? null}
                    trackIndex={0}
                  />
                </div>
                {tracks.length > 1 && (
                  <div className="mobile-zoomed-track">
                    <ZoomedWaveform
                      syncedRef={syncedRef}
                      colorData={colorData[1] ?? null}
                      trackIndex={1}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Track B */}
            {tracks.length > 1 && (
              <div className="waveform-track-group">
                <div
                  className={`waveform-row track-b${
                    activeIndex === 1 ? " active" : ""
                  }`}
                >
                  {tracks.length > 1 && (
                    <button
                      type="button"
                      className={`track-toggle-btn track-b${
                        activeIndex === 1 ? " active" : ""
                      }`}
                      onClick={() => handleToggleTrack(1)}
                      title={`Listen to ${tracks[1].title || "track B"}`}
                    >
                      B
                    </button>
                  )}
                  <RGBWaveform
                    syncedRef={syncedRef}
                    colorData={colorData[1] ?? null}
                    duration={duration}
                    trackDuration={trackDurations[1] ?? duration}
                    isActive={activeIndex === 1}
                    activeColor="#3080e0"
                    onClick={(progress) => {
                      if (clickTimerRef.current)
                        clearTimeout(clickTimerRef.current);
                      clickTimerRef.current = setTimeout(() => {
                        clickTimerRef.current = null;
                        handleToggleTrack(1);
                        if (duration > 0) seek(progress);
                      }, 250);
                    }}
                    onDoubleClick={(progress) => {
                      if (clickTimerRef.current) {
                        clearTimeout(clickTimerRef.current);
                        clickTimerRef.current = null;
                      }
                      handleToggleTrack(1);
                      if (ownerId && tracks[1]?.userId === ownerId) {
                        setCommentTime(progress * duration);
                        skipFocusTimeRef.current = true;
                        commentTextareaRefs.current[1]?.focus();
                      }
                    }}
                  >
                    <div
                      className="comment-marker pending"
                      style={{
                        left:
                          duration > 0 && commentTime !== null
                            ? `${(commentTime / duration) * 100}%`
                            : "0%",
                        display:
                          commentTime !== null && commentTrackIdx === 1
                            ? undefined
                            : "none",
                      }}
                    />
                  </RGBWaveform>
                  <div className="waveform-container waveform-zoomed-side">
                    <ZoomedWaveform
                      syncedRef={syncedRef}
                      colorData={colorData[1] ?? null}
                      trackIndex={1}
                    />
                  </div>
                  <button
                    type="button"
                    className={`btn-favorite${
                      trackQueries[1]?.data?.hasCurrentUserSaved
                        ? " favorited"
                        : ""
                    }`}
                    onClick={() => toggleFavorite(tracks[1].id)}
                    title={
                      trackQueries[1]?.data?.hasCurrentUserSaved
                        ? "Unfavorite this track"
                        : "Favorite this track"
                    }
                  >
                    ♥
                  </button>
                </div>
                <div className="waveform-time-row">
                  {tracks.length > 1 && (
                    <div className="time-row-spacer-toggle" />
                  )}
                  <div className="comment-avatars-strip">
                    {(allComments[1] ?? []).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="comment-avatar-marker"
                        style={{
                          left:
                            duration > 0
                              ? `${(c.timestampSeconds / duration) * 100}%`
                              : "0%",
                        }}
                        title={`@${c.handle}: ${c.body}`}
                        onClick={() => scrollToComment(c.id)}
                      >
                        {c.avatarUrl ? (
                          <AvatarImg
                            src={c.avatarUrl}
                            mirrors={c.avatarMirrors}
                            alt=""
                          />
                        ) : (
                          <span className="comment-avatar-fallback">
                            {c.handle[0]?.toUpperCase()}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="time-row-spacer-right">
                    <span className="time-display">
                      {formatTime(Math.min(currentTime, trackDurations[1]))} /{" "}
                      {formatTime(trackDurations[1])}
                    </span>
                  </div>
                </div>
                {renderCommentForm(1)}
              </div>
            )}
          </div>
        </div>

        {/* Track B Analyzers */}
        {tracks.length > 1 && (
          <div className="analyzers-row track-b">
            <SpectrumAnalyzer
              syncedRef={syncedRef}
              isPlaying={isPlaying}
              trackIndex={1}
              accentColor="#3080e0"
              otherAccentColor="#e06030"
              showOverlay={showOverlay}
            />
            <SpaceAnalyzer
              syncedRef={syncedRef}
              isPlaying={isPlaying}
              trackIndex={1}
              accentColor="#3080e0"
              otherAccentColor="#e06030"
              showOverlay={showOverlay}
            />
            <VolumeIndicator
              syncedRef={syncedRef}
              isPlaying={isPlaying}
              trackIndex={1}
              accentColor="#3080e0"
              otherAccentColor="#e06030"
              showOverlay={showOverlay}
              loudnessStats={loudnessStats[1]}
            />
          </div>
        )}
      </div>
      {/* end listener-above-fold */}

      {/* Comments */}
      <div className="comments-section">
        <div className="comments-columns">
          {tracks.map((track, i) => {
            const comments = allComments[i] ?? [];
            return (
              <div className="comments-column" key={track.id}>
                {tracks.length > 1 && <h3>Track {LABELS[i]}</h3>}

                <div className="comment-list">
                  {comments.length === 0 && (
                    <p className="empty-comments">No comments yet.</p>
                  )}
                  {comments.map((c) => (
                    <div
                      className={`comment-item${
                        highlightedCommentId === c.id ? " highlighted" : ""
                      }`}
                      id={`comment-${c.id}`}
                      key={c.id}
                    >
                      <div className="comment-meta">
                        <span
                          className="comment-timestamp"
                          role="button"
                          onClick={() => {
                            if (duration > 0) {
                              setActive(i);
                              setActiveIndex(i);
                              seek(c.timestampSeconds / duration);
                              if (!isPlaying) {
                                play();
                                setIsPlaying(true);
                              }
                            }
                          }}
                        >
                          {formatTime(c.timestampSeconds)}
                        </span>
                        <span className="comment-author">@{c.handle}</span>
                      </div>
                      {editingComment?.id === c.id ? (
                        <div className="comment-edit-form">
                          <textarea
                            value={editingComment.body}
                            onChange={(e) =>
                              setEditingComment({
                                ...editingComment,
                                body: e.target.value,
                              })
                            }
                            rows={2}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                if (editingComment.body.trim()) {
                                  editComment.mutate({
                                    commentId: c.id,
                                    trackId: track.id,
                                    body: editingComment.body.trim(),
                                  });
                                  setEditingComment(null);
                                }
                              }
                              if (e.key === "Escape") setEditingComment(null);
                            }}
                            autoFocus
                          />
                          <div className="comment-edit-actions">
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              onClick={() => setEditingComment(null)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="btn-primary btn-sm"
                              disabled={!editingComment.body.trim()}
                              onClick={() => {
                                editComment.mutate({
                                  commentId: c.id,
                                  trackId: track.id,
                                  body: editingComment.body.trim(),
                                });
                                setEditingComment(null);
                              }}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="comment-body">{c.body}</div>
                      )}
                      {currentUserId &&
                        (c.userId === currentUserId ||
                          currentUserId === ownerId) &&
                        editingComment?.id !== c.id && (
                          <div className="comment-actions">
                            {c.userId === currentUserId && (
                              <button
                                type="button"
                                className="btn-comment-action"
                                title="Edit comment"
                                onClick={() =>
                                  setEditingComment({
                                    id: c.id,
                                    trackId: track.id,
                                    body: c.body,
                                  })
                                }
                              >
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                                </svg>
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn-comment-action"
                              title="Delete comment"
                              onClick={() =>
                                setDeleteConfirm({
                                  commentId: c.id,
                                  trackId: track.id,
                                })
                              }
                            >
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6" />
                                <path d="M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          </div>
                        )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <p>Delete this comment?</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary btn-danger"
                onClick={() => {
                  deleteComment.mutate({
                    commentId: deleteConfirm.commentId,
                    trackId: deleteConfirm.trackId,
                  });
                  setDeleteConfirm(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Help modal */}
      {showHelp && (
        <div
          className="modal-overlay"
          onClick={() => dismissHelp()}
          onKeyDown={(e) => {
            if (e.key === "Escape") dismissHelp();
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="modal-close"
              onClick={() => dismissHelp()}
            >
              ✕
            </button>
            <h2>A/B Analysis</h2>
            <p>
              Compare two tracks side-by-side with real-time audio analysis.
              Listen, analyze, and leave timestamped comments.
            </p>

            <h3>How to use</h3>
            <ul>
              <li>
                Press play or hit <kbd>Space</kbd> to start playback
              </li>
              <li>
                Click a waveform to seek; click the other track's waveform to
                switch &amp; seek
              </li>
              <li>Hover over a waveform to preview the seek position</li>
              <li>Double-click a waveform to set a comment timestamp</li>
              <li>
                Click a commenter's avatar on the waveform timeline to jump to
                their comment
              </li>
              <li>
                Toggle <strong>A/B Overlay</strong> to compare both tracks'
                analysis side-by-side
              </li>
              <li>
                Hover over the spectrum analyzer to see frequency, note, and dB
                at the cursor
              </li>
              <li>
                Use the analyzers to compare spectrum, stereo field
                (polar/Lissajous), and loudness (LUFS/peak/RMS)
              </li>
              <li>Log in with Audius to leave comments and favorite tracks</li>
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
                  <td>Switch to track A / B</td>
                </tr>
                <tr>
                  <td>
                    <kbd>↑</kbd> / <kbd>↓</kbd>
                  </td>
                  <td>Switch track</td>
                </tr>
                <tr>
                  <td>
                    <kbd>←</kbd> / <kbd>→</kbd>
                  </td>
                  <td>
                    Nudge ±0.5s; hold to fast-seek; <kbd>Shift</kbd> for 4-beat
                    jumps
                  </td>
                </tr>
                <tr>
                  <td>
                    <kbd>C</kbd>
                  </td>
                  <td>Focus comment input at current time</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Enter</kbd>
                  </td>
                  <td>Submit comment</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Shift+Enter</kbd>
                  </td>
                  <td>New line in comment</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Escape</kbd>
                  </td>
                  <td>Unfocus comment input</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
