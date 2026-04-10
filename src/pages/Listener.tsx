import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useSyncedWaveforms } from "../hooks/useSyncedWaveforms";
import { useHotkeys } from "../hooks/useHotkeys";
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
import type { TrackSource } from "../lib/waveforms";
import { useSaveProject } from "../hooks/useSaveProject";
import SpectrumAnalyzer from "../components/SpectrumAnalyzer";
import SpaceAnalyzer, { type SpaceMode } from "../components/SpaceAnalyzer";
import VolumeIndicator, { type GraphMetric } from "../components/VolumeIndicator";
import RGBWaveform from "../components/RGBWaveform";
import ZoomedWaveform from "../components/ZoomedWaveform";
import { useBackgroundVisualizer } from "../contexts/BackgroundVisualizerContext";
import { CopyButton } from "../components/CopyButton";
import { formatTime } from "../lib/utils";

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

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || /\.(mp3|wav|flac|aiff?|ogg|m4a|aac)$/i.test(file.name);
}

export default function Listener() {
  const { playlistId } = useParams<{ playlistId?: string }>();
  const navigate = useNavigate();
  const isCreateMode = !playlistId;

  // Create-mode state
  const createProject = useSaveProject();
  const [editableName, setEditableName] = useState("A/B Test");
  const [editableQuestion, setEditableQuestion] = useState("");
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);
  const [localOverrides, setLocalOverrides] = useState<Record<number, File>>({});
  const [showShareModal, setShowShareModal] = useState(false);

  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [showClearCommentsConfirm, setShowClearCommentsConfirm] = useState(false);
  const [pendingSaveParams, setPendingSaveParams] = useState<{
    name: string;
    question: string;
    existingPlaylistId: string;
    existingTrackIds: string[];
    localOverrides: Record<number, File>;
    replacedTrackIds: string[];
  } | null>(null);
  const fileInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // View-mode data
  const { data: playlist, error: queryError } = usePlaylistTracks(playlistId);
  const viewTracks = playlist?.tracks ?? [];
  const tracks = isCreateMode ? [] : viewTracks; // create mode doesn't use server tracks
  const playlistName = isCreateMode
    ? editableName
    : playlist?.playlistName || (
        viewTracks.length >= 2
          ? `Audius AB: ${viewTracks[0].title} vs ${viewTracks[1].title}`
          : viewTracks.length === 1
            ? `Audius AB: ${viewTracks[0].title}`
            : "Audius AB"
      );
  const description = isCreateMode
    ? editableQuestion
    : (playlist?.description ?? "").replace(/Made with Audius A\/B/g, "").trim();
  const ownerId = playlist?.user?.id ?? null;

  // Dynamic page title
  useEffect(() => {
    const name = isCreateMode ? "New Project" : (playlist?.playlistName || "Audius A/B");
    document.title = `${name} — Audius A/B`;
    return () => { document.title = "Audius A/B — Compare Audio Mixes Side by Side"; };
  }, [isCreateMode, playlist?.playlistName]);

  // Sync editable fields when playlist loads
  const [initializedFromPlaylist, setInitializedFromPlaylist] = useState(false);
  useEffect(() => {
    if (playlist && !initializedFromPlaylist) {
      setEditableName(playlist.playlistName || "A/B Test");
      const desc = (playlist.description ?? "").replace(/Made with Audius A\/B/g, "").trim();
      setEditableQuestion(desc);
      setInitializedFromPlaylist(true);
    }
  }, [playlist, initializedFromPlaylist]);

  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [linkAnalyzers, setLinkAnalyzers] = useState(true);
  const [spaceModeA, setSpaceModeA] = useState<SpaceMode>("polar-sample");
  const [spaceModeB, setSpaceModeB] = useState<SpaceMode>("polar-sample");
  const [graphMetricA, setGraphMetricA] = useState<GraphMetric>("short");
  const [graphMetricB, setGraphMetricB] = useState<GraphMetric>("short");
  const handleSpaceModeA = (m: SpaceMode) => { setSpaceModeA(m); if (linkAnalyzers) setSpaceModeB(m); };
  const handleSpaceModeB = (m: SpaceMode) => { setSpaceModeB(m); if (linkAnalyzers) setSpaceModeA(m); };
  const handleGraphMetricA = (m: GraphMetric) => { setGraphMetricA(m); if (linkAnalyzers) setGraphMetricB(m); };
  const handleGraphMetricB = (m: GraphMetric) => { setGraphMetricB(m); if (linkAnalyzers) setGraphMetricA(m); };
  const [commentText, setCommentText] = useState("");
  const [commentTrackIdx, setCommentTrackIdx] = useState(0);
  const [commentTime, setCommentTime] = useState<number | null>(null);

  const [showHelp, setShowHelp] = useState(() => !localStorage.getItem('helpDismissed:analyze'));
  const dismissHelp = () => { localStorage.setItem('helpDismissed:analyze', '1'); setShowHelp(false); };
  const [showOverlay, setShowOverlay] = useState(true);
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
  const [loginError, setLoginError] = useState<string | null>(null);
  const canEdit = isCreateMode || (!!currentUserId && currentUserId === ownerId);

  // Dirty state: are there unsaved changes?
  const serverName = playlist?.playlistName || "A/B Test";
  const serverDesc = (playlist?.description ?? "").replace(/Made with Audius A\/B/g, "").trim();
  const hasMetadataChanges = !isCreateMode && initializedFromPlaylist && (
    editableName !== serverName || editableQuestion !== serverDesc
  );
  const hasLocalOverrides = Object.keys(localOverrides).length > 0;
  const hasUnsavedChanges = isCreateMode
    ? createProject.tracks.length > 0 || editableName !== "A/B Test" || editableQuestion !== ""
    : hasMetadataChanges || hasLocalOverrides;

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

  const waveformSources: TrackSource[] = useMemo(() => {
    if (isCreateMode) {
      return createProject.tracks.map((t) => ({
        type: 'file' as const,
        file: t.file,
        localId: `local-${t.key}`,
      }));
    }
    return tracks.map((t, i) => {
      const override = localOverrides[i];
      if (override) {
        return {
          type: 'file' as const,
          file: override,
          localId: `override-${i}-${override.name}-${override.lastModified}`,
        };
      }
      return {
        type: 'url' as const,
        urls: getStreamUrls(t.stream),
        trackId: t.id,
      };
    });
  }, [isCreateMode, createProject.tracks, tracks, localOverrides]);

  const {
    isReady,
    loadError: waveformError,
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
    waveformSources,
    (time) => {
      setCommentTime(time);
    },
    () => {
      setIsPlaying(false);
    }
  );

  const loadError = waveformError ?? (isCreateMode ? null : (queryError?.message ?? null));

  // Delay showing loading modal by 1s
  useEffect(() => {
    if (playlist || (tracks.length && isReady)) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), 1000);
    return () => clearTimeout(timer);
  }, [playlist, tracks.length, isReady]);

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

  // Ref for current time used by comment hotkey
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  useHotkeys({
    activeIndex,
    isPlaying,
    duration,
    currentTime,
    bpms,
    trackCount: tracks.length,
    syncedRef,
    seek,
    play,
    pause,
    setIsPlaying,
    onToggleTrack: handleToggleTrack,
    onExtraKey: (e) => {
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        setCommentTrackIdx(activeIndex);
        setCommentTime(currentTimeRef.current);
        commentTextareaRefs.current[activeIndex]?.focus();
        return true;
      }
      return false;
    },
  });

  function handleToggleTrack(i: number) {
    setActiveIndex(i);
    setActive(i);
    setCommentTrackIdx(i);
  }

  function renderCommentForm(i: number) {
    const hasTrack = i === 0 ? hasTrackA : hasTrackB;
    const trackOwnedByCreator = isCreateMode || (!!ownerId && tracks[i]?.userId === ownerId);
    const hasOverride = !!localOverrides[i];
    const commentDisabled = !hasTrack || !trackOwnedByCreator || hasOverride;
    const disabledReason = !hasTrack
      ? "Add a track to enable comments"
      : hasOverride
        ? "Save to enable comments on replaced track"
        : isCreateMode
          ? "Save your project to enable comments"
          : !currentUserId
            ? "Log in to comment"
            : !trackOwnedByCreator
              ? "Track not owned by project owner"
              : "";
    return (
      <div className="comment-form">
        <textarea
          ref={(el) => {
            commentTextareaRefs.current[i] = el;
          }}
          rows={1}
          placeholder={
            commentDisabled
              ? disabledReason
              : hasTrackB ? `Comment on ${LABELS[i]}…` : "Leave a comment…"
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
          disabled={commentDisabled || postComment.isPending}
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
            commentDisabled ||
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
    if (!commentText.trim()) return;
    if (isCreateMode) {
      setShowSavePrompt(true);
      return;
    }
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

  const executeSave = useCallback((clearCommentTrackIds?: string[]) => {
    if (isCreateMode) {
      // Create new project
      createProject.mutation.mutate(
        { name: editableName, question: editableQuestion, waveformColorData: colorData },
        {
          onSuccess: (newPlaylistId) => {
            setShowShareModal(true);
            navigate(`/analyze/${newPlaylistId}`, { replace: true });
          },
        }
      );
    } else if (playlistId) {
      // Update existing project
      createProject.mutation.mutate(
        {
          name: editableName,
          question: editableQuestion,
          existingPlaylistId: playlistId,
          existingTrackIds: tracks.map((t) => t.id),
          localOverrides,
          clearCommentTrackIds,
          waveformColorData: colorData,
        },
        {
          onSuccess: () => {
            setLocalOverrides({});
          },
        }
      );
    }
  }, [isCreateMode, createProject, editableName, editableQuestion, navigate, playlistId, tracks, localOverrides, colorData]);

  const handleSave = useCallback(() => {
    if (!isCreateMode && hasLocalOverrides && playlistId) {
      // Check if any replaced tracks have comments
      const replacedTrackIds: string[] = [];
      for (const slotStr of Object.keys(localOverrides)) {
        const slot = Number(slotStr);
        const trackId = tracks[slot]?.id;
        if (trackId) {
          const comments = allComments[slot] ?? [];
          if (comments.length > 0) {
            replacedTrackIds.push(trackId);
          }
        }
      }
      if (replacedTrackIds.length > 0) {
        setPendingSaveParams({
          name: editableName,
          question: editableQuestion,
          existingPlaylistId: playlistId,
          existingTrackIds: tracks.map((t) => t.id),
          localOverrides,
          replacedTrackIds,
        });
        setShowClearCommentsConfirm(true);
        return;
      }
    }
    executeSave();
  }, [isCreateMode, hasLocalOverrides, playlistId, localOverrides, tracks, allComments, editableName, editableQuestion, executeSave]);

  function handleFileSelect(slot: number, file: File) {
    if (isCreateMode) {
      if (createProject.tracks.length > slot) {
        createProject.replaceTrack(slot, file);
      } else {
        createProject.addFiles([file]);
      }
    } else {
      setLocalOverrides((prev) => ({ ...prev, [slot]: file }));
    }
  }

  function handleDropFile(slot: number, e: React.DragEvent) {
    e.preventDefault();
    setDragOverSlot(null);
    const files = Array.from(e.dataTransfer.files).filter(isAudioFile);
    if (files.length === 0) return;
    handleFileSelect(slot, files[0]);
  }

  const hasTrackA = isCreateMode ? createProject.tracks.length >= 1 : tracks.length >= 1;
  const hasTrackB = isCreateMode ? createProject.tracks.length >= 2 : tracks.length >= 2;

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

  if (!isCreateMode && !playlist) {
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
            {canEdit && (
              <button
                type="button"
                className="btn-header btn-save"
                onClick={handleSave}
                disabled={!hasUnsavedChanges || createProject.mutation.isPending}
                title="Save project"
                aria-label="Save project"
              >
                {createProject.mutation.isPending ? (
                  <span className="spinner spinner-btn" />
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                )}
                {createProject.mutation.isPending ? "Saving…" : "Save"}
              </button>
            )}
            {playlistId && (
              <>
                <Link
                  to={`/blind/${playlistId}`}
                  className="btn-header btn-share"
                  title="View blind A/B test"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                  Blind
                </Link>
                <button
                  type="button"
                  className="btn-header btn-share"
                  onClick={() => setShowShareModal(true)}
                  title="Share links"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                    <polyline points="16 6 12 2 8 6" />
                    <line x1="12" y1="2" x2="12" y2="15" />
                  </svg>
                  Share
                </button>
              </>
            )}
            <button
              type="button"
              className="btn-header btn-header-text"
              onClick={() => {
                if (hasUnsavedChanges) {
                  setShowDiscardConfirm(true);
                } else if (isCreateMode) {
                  window.location.href = "/analyze";
                } else {
                  navigate("/analyze");
                }
              }}
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
              aria-label="Help"
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
          <div className="header-playback-row">
            <button
              type="button"
              className="btn-playpause btn-playpause-lg"
              onClick={handlePlayPause}
              disabled={!isReady}
              title={isPlaying ? "Pause" : "Play"}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
            <div className="header-title-group">
              {canEdit ? (
                <>
                  <h1
                    className="editable-title"
                    contentEditable
                    suppressContentEditableWarning
                    role="textbox"
                    aria-label="Project name"
                    onBlur={(e) => setEditableName(e.currentTarget.textContent || "")}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
                    dangerouslySetInnerHTML={{ __html: editableName }}
                    data-placeholder="Project name"
                  />
                  <span
                    className="editable-question listener-question"
                    contentEditable
                    suppressContentEditableWarning
                    role="textbox"
                    aria-label="Question for listeners"
                    onBlur={(e) => setEditableQuestion(e.currentTarget.textContent || "")}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
                    dangerouslySetInnerHTML={{ __html: editableQuestion }}
                    data-placeholder="Add a question for listeners…"
                  />
                </>
              ) : (
                <>
                  <h1>{playlistName}</h1>
                  {description && (
                    <span className="listener-question">{description}</span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {!isReady && showLoading && hasTrackA && (
          <div className="modal-overlay">
            <div className="modal loading-modal">
              <div className="spinner" />
              <p>{isCreateMode ? "Decoding audio…" : "Fetching and decoding audio…"}</p>
            </div>
          </div>
        )}

        {createProject.mutation.isError && (
          <p className="status-msg error" style={{ margin: '8px 16px' }}>
            Error: {(createProject.mutation.error as Error)?.message ?? 'Save failed'}
          </p>
        )}

        {/* Analyzer overlay toggle */}
        <div className="analyzer-overlay-bar">
          <button
            type="button"
            className={`overlay-toggle${showOverlay ? " active" : ""}`}
            onClick={() => setShowOverlay((v) => !v)}
          >
            A/B Overlay
          </button>
          <button
            type="button"
            className={`overlay-toggle${linkAnalyzers ? " active" : ""}`}
            onClick={() => setLinkAnalyzers((v) => !v)}
            title="Sync analyzer settings between A and B"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            Link
          </button>
        </div>

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
            {hasTrackB && (
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
                mode={mobileAnalyzerTrack === "b" ? spaceModeB : spaceModeA}
                onModeChange={mobileAnalyzerTrack === "b" ? handleSpaceModeB : handleSpaceModeA}
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
                graphMetric={mobileAnalyzerTrack === "b" ? graphMetricB : graphMetricA}
                onGraphMetricChange={mobileAnalyzerTrack === "b" ? handleGraphMetricB : handleGraphMetricA}
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
            mode={spaceModeA}
            onModeChange={handleSpaceModeA}
          />
          <VolumeIndicator
            syncedRef={syncedRef}
            isPlaying={isPlaying}
            trackIndex={0}
            accentColor="#e06030"
            otherAccentColor="#3080e0"
            showOverlay={showOverlay}
            loudnessStats={loudnessStats[0]}
            graphMetric={graphMetricA}
            onGraphMetricChange={handleGraphMetricA}
          />
        </div>

        {/* Waveform area */}
        <div className="waveform-area">
          <div className="waveform-area-center">
            {/* Track A */}
              <div className="waveform-track-group">
                {renderCommentForm(0)}
                <div className="waveform-time-row">
                  <div className="time-row-spacer-toggle" />
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
                  hasTrackA && activeIndex === 0 ? " active" : ""
                }${!hasTrackA || dragOverSlot === 0 ? " waveform-dropzone" : ""}${dragOverSlot === 0 ? " drag-over" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOverSlot(0); }}
                onDragLeave={() => setDragOverSlot(null)}
                onDrop={(e) => handleDropFile(0, e)}
              >
                <input
                  ref={(el) => { fileInputRefs.current[0] = el; }}
                  type="file"
                  accept="audio/*"
                  className="hidden-file-input"
                  onChange={(e) => {
                    if (e.target.files?.length) handleFileSelect(0, e.target.files[0]);
                    e.target.value = '';
                  }}
                />
                {dragOverSlot === 0 && hasTrackA && (
                  <div className="drop-overlay">
                    <span>Drop to replace A</span>
                  </div>
                )}
                {hasTrackA ? (
                  <>
                    <button
                      type="button"
                      className={`track-toggle-btn track-a${
                        activeIndex === 0 ? " active" : ""
                      }`}
                      onClick={() => activeIndex === 0 ? handlePlayPause() : handleToggleTrack(0)}
                      title={activeIndex === 0 ? (isPlaying ? "Pause" : "Play") : "Switch to track A"}
                    >
                      <span className="toggle-letter">A</span>
                      <span className="toggle-playpause">{isPlaying ? "⏸" : "▶"}</span>
                    </button>
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
                        setCommentTime(progress * duration);
                        skipFocusTimeRef.current = true;
                        commentTextareaRefs.current[0]?.focus();
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
                    {!isCreateMode && (
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
                    )}
                  </>
                ) : (
                  <div
                    className="waveform-container dropzone-content"
                    onClick={() => fileInputRefs.current[0]?.click()}
                  >
                    <span className="dropzone-label">A</span>
                    <span className="dropzone-text">Drop audio file or click to browse</span>
                  </div>
                )}
              </div>
              </div>

            {/* Mobile zoomed waveforms (between overview waveforms) */}
              <div className="mobile-zoomed-waveforms">
                <div className="mobile-zoomed-track">
                  <ZoomedWaveform
                    syncedRef={syncedRef}
                    colorData={colorData[0] ?? null}
                    trackIndex={0}
                  />
                </div>
                <div className="mobile-zoomed-track">
                  <ZoomedWaveform
                    syncedRef={syncedRef}
                    colorData={colorData[1] ?? null}
                    trackIndex={1}
                  />
                </div>
              </div>

            {/* Track B */}
              <div className="waveform-track-group">
                <div
                  className={`waveform-row track-b${
                    hasTrackB && activeIndex === 1 ? " active" : ""
                  }${!hasTrackB || dragOverSlot === 1 ? " waveform-dropzone" : ""}${dragOverSlot === 1 ? " drag-over" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOverSlot(1); }}
                  onDragLeave={() => setDragOverSlot(null)}
                  onDrop={(e) => handleDropFile(1, e)}
                >
                  <input
                    ref={(el) => { fileInputRefs.current[1] = el; }}
                    type="file"
                    accept="audio/*"
                    className="hidden-file-input"
                    onChange={(e) => {
                      if (e.target.files?.length) handleFileSelect(1, e.target.files[0]);
                      e.target.value = '';
                    }}
                  />
                  {dragOverSlot === 1 && hasTrackB && (
                    <div className="drop-overlay">
                      <span>Drop to replace B</span>
                    </div>
                  )}
                  {hasTrackB ? (
                    <>
                      <button
                        type="button"
                        className={`track-toggle-btn track-b${
                          activeIndex === 1 ? " active" : ""
                        }`}
                        onClick={() => activeIndex === 1 ? handlePlayPause() : handleToggleTrack(1)}
                        title={activeIndex === 1 ? (isPlaying ? "Pause" : "Play") : "Switch to track B"}
                      >
                        <span className="toggle-letter">B</span>
                        <span className="toggle-playpause">{isPlaying ? "⏸" : "▶"}</span>
                      </button>
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
                          setCommentTime(progress * duration);
                          skipFocusTimeRef.current = true;
                          commentTextareaRefs.current[1]?.focus();
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
                      {!isCreateMode && (
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
                      )}
                    </>
                  ) : (
                    <div
                      className="waveform-container dropzone-content"
                      onClick={() => fileInputRefs.current[1]?.click()}
                    >
                      <span className="dropzone-label">B</span>
                      <span className="dropzone-text">Drop audio file or click to browse</span>
                    </div>
                  )}
                </div>
                <div className="waveform-time-row">
                  <div className="time-row-spacer-toggle" />
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
                      {formatTime(Math.min(currentTime, trackDurations[1] ?? duration))}{" "}
                      / {formatTime(trackDurations[1] ?? duration)}
                    </span>
                  </div>
                </div>
                {renderCommentForm(1)}
              </div>
          </div>
        </div>

        {/* Track B Analyzers */}
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
              mode={spaceModeB}
              onModeChange={handleSpaceModeB}
            />
            <VolumeIndicator
              syncedRef={syncedRef}
              isPlaying={isPlaying}
              trackIndex={1}
              accentColor="#3080e0"
              otherAccentColor="#e06030"
              showOverlay={showOverlay}
              loudnessStats={loudnessStats[1]}
              graphMetric={graphMetricB}
              onGraphMetricChange={handleGraphMetricB}
            />
          </div>
      </div>
      {/* end listener-above-fold */}

      {/* Comments */}
      <div className="comments-section">
        <div className="comments-columns">
          {(isCreateMode
            ? LABELS.slice(0, 2).map((label, i) => ({ id: `local-${i}`, label, i }))
            : tracks.map((track, i) => ({ id: track.id, label: LABELS[i], i }))
          ).map(({ id, label, i }) => {
            const comments = isCreateMode ? [] : (allComments[i] ?? []);
            return (
              <div className="comments-column" key={id}>
                {hasTrackB && <h3>Track {label}</h3>}

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
                                    trackId: id,
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
                                  trackId: id,
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
                                    trackId: id,
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
                                  trackId: id,
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

      {/* Share modal */}
      {showShareModal && playlistId && (() => {
        const analyzeUrl = `${window.location.origin}/analyze/${playlistId}`;
        const blindUrl = `${window.location.origin}/blind/${playlistId}`;
        return (
          <div className="modal-overlay" onClick={() => setShowShareModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="modal-close" onClick={() => setShowShareModal(false)}>
                ✕
              </button>
              <h2>Share</h2>
              <p>Share these links with your listeners:</p>
              <div className="share-links">
                <div className="share-link-group">
                  <label>Analysis link</label>
                  <span className="share-link-desc">Full view with track names and analyzers</span>
                  <div className="share-link-row">
                    <input type="text" readOnly value={analyzeUrl} />
                    <CopyButton url={analyzeUrl} />
                  </div>
                </div>
                <div className="share-link-group">
                  <label>Blind test link</label>
                  <span className="share-link-desc">Track names hidden for unbiased listening</span>
                  <div className="share-link-row">
                    <input type="text" readOnly value={blindUrl} />
                    <CopyButton url={blindUrl} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Publish prompt modal */}
      {showSavePrompt && (
        <div className="modal-overlay" onClick={() => setShowSavePrompt(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <p>Save your project first to enable comments.</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowSavePrompt(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setShowSavePrompt(false);
                  handleSave();
                }}
              >
                Save now
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* Discard confirmation modal */}
      {showDiscardConfirm && (
        <div className="modal-overlay" onClick={() => setShowDiscardConfirm(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <p>You have unsaved changes. Discard them?</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowDiscardConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary btn-danger"
                onClick={() => {
                  setShowDiscardConfirm(false);
                  window.location.href = "/analyze";
                }}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear comments confirmation modal */}
      {showClearCommentsConfirm && pendingSaveParams && (
        <div className="modal-overlay" onClick={() => { setShowClearCommentsConfirm(false); setPendingSaveParams(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="modal-close" onClick={() => { setShowClearCommentsConfirm(false); setPendingSaveParams(null); }}>
              ✕
            </button>
            <h2>Replace Track Audio</h2>
            <p>You're replacing track audio. Would you like to clear the existing comments on the replaced tracks?</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowClearCommentsConfirm(false);
                  executeSave();
                  setPendingSaveParams(null);
                }}
              >
                Keep Comments
              </button>
              <button
                type="button"
                className="btn-primary btn-danger"
                onClick={() => {
                  setShowClearCommentsConfirm(false);
                  executeSave(pendingSaveParams.replacedTrackIds);
                  setPendingSaveParams(null);
                }}
              >
                Clear Comments
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

            <h3>Creating a project</h3>
            <ul>
              <li>Drag and drop audio files onto the waveform areas, or click to browse</li>
              <li>Edit the project name and add a question for your listeners</li>
              <li>Click <strong>Save</strong> to upload and create your project</li>
              <li>Use <strong>Share</strong> to get links — <em>Analysis</em> shows track names and analyzers, <em>Blind Test</em> hides names for unbiased feedback</li>
              <li>You can replace track audio at any time by dropping a new file</li>
            </ul>

            <h3>Analyzing</h3>
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
