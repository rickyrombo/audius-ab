import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { decodeHashId } from '@audius/sdk'
import { getSDK } from '../lib/audius'
import { useSyncedWaveforms } from '../hooks/useSyncedWaveforms'
import SpectrumAnalyzer from '../components/SpectrumAnalyzer'
import SpaceAnalyzer from '../components/SpaceAnalyzer'
import VolumeIndicator from '../components/VolumeIndicator'

const LABELS = ['A', 'B']

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

interface TrackInfo {
  id: string
  title: string
  streamUrl: string
}

interface CommentDisplay {
  id: string
  userId: string
  handle: string
  body: string
  timestampSeconds: number
}

export default function Listener() {
  const { playlistId } = useParams<{ playlistId: string }>()
  const navigate = useNavigate()

  const [description, setDescription] = useState('')
  const [playlistName, setPlaylistName] = useState('Audius AB')
  const [tracks, setTracks] = useState<TrackInfo[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentTrackIdx, setCommentTrackIdx] = useState(0)
  const [commentTime, setCommentTime] = useState<number | null>(null)
  const [favorited, setFavorited] = useState<Set<string>>(new Set())
  const [submittingComment, setSubmittingComment] = useState(false)
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [currentUserHandle, setCurrentUserHandle] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)

  const containerRefs = useRef<(HTMLDivElement | null)[]>([])
  const commentTextareaRefs = useRef<(HTMLTextAreaElement | null)[]>([])
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipFocusTimeRef = useRef(false)
  const queryClient = useQueryClient()

  const commentQueries = useQueries({
    queries: tracks.map((t) => ({
      queryKey: ['comments', t.id],
      queryFn: async (): Promise<CommentDisplay[]> => {
        const sdk = getSDK()
        const resp = await sdk.tracks.getTrackComments({ trackId: t.id })
        const items = resp.data ?? []
        const users = resp.related?.users ?? []
        const handleMap = new Map(users.map((u) => [u.id, u.handle]))
        return items.map((c) => ({
          id: c.id,
          userId: c.userId ?? '',
          handle: (c.userId && handleMap.get(c.userId)) ?? c.userId ?? 'anon',
          body: c.message,
          timestampSeconds: c.trackTimestampS ?? 0,
        }))
      },
      enabled: !!t.id,
      staleTime: Infinity,
    })),
  })
  const allComments = commentQueries.map((q) => {
    const comments = q.data ?? []
    if (!ownerId && !currentUserId) return comments
    return comments.filter((c) => 
      (ownerId && c.userId === ownerId) || (currentUserId && c.userId === currentUserId)
    )
  })

  const streamUrls = tracks.map((t) => t.streamUrl)

  const { isReady, currentTime, duration, trackDurations, play, pause, seek, setActive, syncedRef } =
    useSyncedWaveforms(containerRefs, streamUrls, (time) => {
      setCommentTime(time)
    }, () => {
      setIsPlaying(false)
    })

  // Load playlist + tracks on mount
  useEffect(() => {
    if (!playlistId) return

    const sdk = getSDK()
    let cancelled = false

    async function load() {
      try {
        // Fetch playlist metadata
        const playlistResp = await sdk.playlists.getPlaylist({ playlistId: playlistId! })
        const playlist = playlistResp.data?.[0]
        if (!playlist) throw new Error('Playlist not found')
        if (cancelled) return

        setDescription(playlist.description ?? '')
        if (playlist.user?.id) setOwnerId(playlist.user.id)

        // Get track IDs from playlist_contents
        const contents = (playlist as any).playlistContents ?? (playlist as any).playlist_contents ?? []
        const trackIds: string[] = contents
          .map((c: any) => c.trackId ?? c.track_id)
          .filter(Boolean)
        if (!trackIds.length) throw new Error('No tracks in playlist')
        if (cancelled) return

        // Fetch tracks in bulk
        const bulkResp = await sdk.tracks.getBulkTracks({ id: trackIds })
        const bulkTracks = bulkResp.data ?? []
        const trackInfos: TrackInfo[] = trackIds
          .map((id) => {
            const t = bulkTracks.find((bt: any) => bt.id === id)
            if (!t) return null
            return {
              id: t.id,
              title: t.title,
              streamUrl: t.stream?.url ?? t.stream?.mirrors?.[0] ?? '',
            }
          })
          .filter((t): t is TrackInfo => t !== null)

        const fallbackName = trackInfos.length >= 2
          ? `Audius AB: ${trackInfos[0].title} vs ${trackInfos[1].title}`
          : `Audius AB: ${trackInfos[0].title}`
        setPlaylistName(playlist.playlistName || fallbackName)

        if (!cancelled) {
          setTracks(trackInfos)
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load')
      }
    }

    load()
    return () => { cancelled = true }
  }, [playlistId])

  // Check if user is already logged in (don't force login)
  useEffect(() => {
    const sdk = getSDK()
    sdk.oauth.isAuthenticated().then(async (isAuth) => {
      if (isAuth) {
        const user = await sdk.oauth.getUser()
        if (user?.id) setCurrentUserId(user.id)
        if (user?.handle) setCurrentUserHandle(user.handle)
      }
    }).catch(() => {})
  }, [])

  // Keep containerRefs array sized correctly when tracks load
  useEffect(() => {
    containerRefs.current = containerRefs.current.slice(0, tracks.length)
  }, [tracks.length])

  // Refs for hotkey handlers to avoid stale closures
  const activeIndexRef = useRef(activeIndex)
  activeIndexRef.current = activeIndex
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying
  const durationRef = useRef(duration)
  durationRef.current = duration
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime
  const seekRef = useRef(seek)
  seekRef.current = seek
  const playRef = useRef(play)
  playRef.current = play
  const pauseRef = useRef(pause)
  pauseRef.current = pause

  // Hotkeys
  useEffect(() => {
    const NUDGE_SECS = 5
    const FF_INTERVAL_MS = 80
    const FF_SECS_PER_TICK = 3
    const HOLD_THRESHOLD_MS = 300
    let holdTimer: ReturnType<typeof setTimeout> | null = null
    let ffInterval: ReturnType<typeof setInterval> | null = null
    let didHold = false

    function seekRelative(deltaSecs: number) {
      const dur = durationRef.current
      if (dur <= 0) return
      const cur = currentTimeRef.current
      const newTime = Math.max(0, Math.min(dur, cur + deltaSecs))
      seekRef.current?.(newTime / dur)
    }

    function startFastSeek(dir: number) {
      if (ffInterval) return
      didHold = true
      ffInterval = setInterval(() => {
        seekRelative(dir * FF_SECS_PER_TICK)
      }, FF_INTERVAL_MS)
    }

    function stopFastSeek() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
      if (ffInterval) { clearInterval(ffInterval); ffInterval = null }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return

      if (e.key === ' ') {
        e.preventDefault()
        if (isPlayingRef.current) {
          pauseRef.current?.()
          setIsPlaying(false)
        } else {
          playRef.current?.()
          setIsPlaying(true)
        }
        return
      }

      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault()
        const idx = activeIndexRef.current
        setCommentTrackIdx(idx)
        setCommentTime(currentTimeRef.current)
        commentTextareaRefs.current[idx]?.focus()
        return
      }

      const numIdx = ['1', '2'].indexOf(e.key)
      if (numIdx !== -1 && numIdx < tracks.length) {
        handleToggleTrack(numIdx)
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = Math.max(0, activeIndexRef.current - 1)
        if (prev !== activeIndexRef.current) handleToggleTrack(prev)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = Math.min(tracks.length - 1, activeIndexRef.current + 1)
        if (next !== activeIndexRef.current) handleToggleTrack(next)
        return
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        if (e.repeat) return
        const dir = e.key === 'ArrowRight' ? 1 : -1
        didHold = false
        holdTimer = setTimeout(() => startFastSeek(dir), HOLD_THRESHOLD_MS)
        return
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = e.key === 'ArrowRight' ? 1 : -1
        stopFastSeek()
        if (!didHold) {
          seekRelative(dir * NUDGE_SECS)
          if (!isPlayingRef.current) {
            playRef.current?.()
            setIsPlaying(true)
          }
        }
        didHold = false
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      stopFastSeek()
    }
  }, [tracks])

  function handleToggleTrack(i: number) {
    setActiveIndex(i)
    setActive(i)
    setCommentTrackIdx(i)
  }

  function renderCommentForm(i: number) {
    return (
      <div className="comment-form">
        <textarea
          ref={(el) => { commentTextareaRefs.current[i] = el }}
          rows={1}
          placeholder={tracks.length > 1 ? `Comment on ${LABELS[i]}…` : 'Leave a comment…'}
          value={commentTrackIdx === i ? commentText : ''}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.currentTarget.blur()
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (commentTrackIdx === i && commentText.trim()) {
                handleComment()
              }
            }
          }}
          onFocus={() => {
            setCommentTrackIdx(i)
            if (skipFocusTimeRef.current) {
              skipFocusTimeRef.current = false
            } else {
              setCommentTime(currentTime)
            }
          }}
          onChange={(e) => {
            setCommentTrackIdx(i)
            setCommentText(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = e.target.scrollHeight + 'px'
          }}
          onBlur={(e) => {
            if (!e.target.value.trim()) {
              setCommentTime(null)
              e.target.style.height = ''
            }
          }}
          disabled={submittingComment}
        />
        {commentTrackIdx === i && commentTime !== null && (
          <span className="comment-at-badge">{formatTime(commentTime)}</span>
        )}
        <button
          type="button"
          className="btn-comment"
          onClick={() => { setCommentTrackIdx(i); handleComment() }}
          disabled={!(commentTrackIdx === i && commentText.trim()) || submittingComment}
        >
          {submittingComment && commentTrackIdx === i ? 'Posting…' : 'Post'}
        </button>
      </div>
    )
  }

  function handlePlayPause() {
    if (isPlaying) {
      pause()
      setIsPlaying(false)
    } else {
      play()
      setIsPlaying(true)
    }
  }

  async function ensureUser() {
    const sdk = getSDK()
    const isAuth = await sdk.oauth.isAuthenticated()
    if (!isAuth) {
      await sdk.oauth.login({ scope: 'write' })
    }
    const user = await sdk.oauth.getUser()
    if (user?.id) setCurrentUserId(user.id)
    if (user?.handle) setCurrentUserHandle(user.handle)
    return user
  }

  async function handleFavorite(trackId: string) {
    try {
      const sdk = getSDK()
      const user = await ensureUser()
      await sdk.tracks.favoriteTrack({ userId: user.id, trackId })
      setFavorited((prev) => new Set([...prev, trackId]))
    } catch (err) {
      console.error('Favorite failed:', err)
    }
  }

  async function handleComment() {
    if (!commentText.trim() || !tracks.length) return
    const trackId = tracks[commentTrackIdx]?.id
    if (!trackId) return

    setSubmittingComment(true)
    try {
      const sdk = getSDK()
      const user = await ensureUser()

      const numericId = decodeHashId(trackId)
      if (numericId === null) throw new Error('Invalid track ID')

      await sdk.comments.createComment({
        userId: user.id,
        metadata: {
          entityType: 'Track' as const,
          entityId: numericId,
          body: commentText.trim(),
          trackTimestampS: Math.floor(commentTime ?? currentTime),
        },
      })

      setCommentText('')
      setCommentTime(null)
      // Invalidate comments cache to refetch
      await queryClient.invalidateQueries({ queryKey: ['comments', trackId] })
    } catch (err) {
      console.error('Comment failed:', err)
    } finally {
      setSubmittingComment(false)
    }
  }

  if (loadError) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Audius AB</h1>
        </div>
        <p className="status-msg error">Error: {loadError}</p>
      </div>
    )
  }

  if (!tracks.length) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Audius AB</h1>
        </div>
        <p className="loading-msg">Loading playlist…</p>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-header">
        <button
          type="button"
          className="btn-playpause btn-playpause-lg"
          onClick={handlePlayPause}
          disabled={!isReady}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <div className="header-title-group">
          <h1>{playlistName}</h1>
          {description && <span className="listener-question">{description}</span>}
        </div>
        <div className="header-actions">
          <button type="button" className="btn-header btn-login" onClick={() => navigate('/')} title="Create new AB test">
            + New
          </button>
          <button type="button" className="btn-header" onClick={() => setShowHelp(true)} title="Help">
            ?
          </button>
          {currentUserHandle ? (
            <span className="logged-in-badge">@{currentUserHandle}</span>
          ) : (
            <button type="button" className="btn-header btn-login" onClick={() => { ensureUser().catch((err) => console.error('Login failed:', err)) }} title="Log in with Audius">
              Log in
            </button>
          )}
        </div>
      </div>

      {!isReady && (
        <div className="modal-overlay">
          <div className="modal loading-modal">
            <div className="spinner" />
            <p>Fetching and decoding audio…</p>
          </div>
        </div>
      )}

      {/* Track A Analyzers */}
      <div className="analyzers-row">
        <SpectrumAnalyzer syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={0} />
        <SpaceAnalyzer syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={0} />
        <VolumeIndicator syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={0} />
      </div>

      {/* Waveform area */}
      <div className="waveform-area">

        <div className="waveform-area-center">
          {/* Track rows */}
          <div className="track-rows">
            {tracks.map((track, i) => (
              <div key={track.id}>
                {/* Comment input above track A */}
                {i === 0 && renderCommentForm(i)}
                {i === 0 && (
                  <div className="waveform-time-row">
                    <span className="time-display">
                      {formatTime(Math.min(currentTime, trackDurations[0] ?? duration))} / {formatTime(trackDurations[0] ?? duration)}
                    </span>
                  </div>
                )}

                <div
                  className={`waveform-row${activeIndex === i ? ' active' : ''}`}
                >
                {tracks.length > 1 && (
                  <button
                    type="button"
                    className={`track-toggle-btn${activeIndex === i ? ' active' : ''}`}
                    onClick={() => handleToggleTrack(i)}
                    title={`Listen to ${track.title || `track ${LABELS[i]}`}`}
                  >
                    {LABELS[i]}
                  </button>
                )}
                <div
                  ref={(el) => { containerRefs.current[i] = el }}
                  className="waveform-container"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
                    clickTimerRef.current = setTimeout(() => {
                      clickTimerRef.current = null
                      handleToggleTrack(i)
                      if (duration > 0) seek(progress)
                    }, 250)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (clickTimerRef.current) {
                      clearTimeout(clickTimerRef.current)
                      clickTimerRef.current = null
                    }
                    handleToggleTrack(i)
                    const rect = e.currentTarget.getBoundingClientRect()
                    const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                    setCommentTime(progress * duration)
                    skipFocusTimeRef.current = true
                    commentTextareaRefs.current[i]?.focus()
                  }}
                >
                  {/* Pending comment marker */}
                  <div
                    className="comment-marker pending"
                    style={{
                      left: duration > 0 && commentTime !== null ? `${(commentTime / duration) * 100}%` : '0%',
                      display: commentTime !== null && commentTrackIdx === i ? undefined : 'none',
                    }}
                  />
                </div>
                <button
                  type="button"
                  className={`btn-favorite${favorited.has(track.id) ? ' favorited' : ''}`}
                  onClick={() => handleFavorite(track.id)}
                  title="Favorite this track"
                >
                  ♥
                </button>
              </div>

                {/* Time display below track B */}
                {i === 1 && trackDurations.length > 1 && (
                  <div className="waveform-time-row">
                    <span className="time-display">
                      {formatTime(Math.min(currentTime, trackDurations[1]))} / {formatTime(trackDurations[1])}
                    </span>
                  </div>
                )}
                {/* Comment input below track B */}
                {i === 1 && renderCommentForm(i)}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Track B Analyzers */}
      {tracks.length > 1 && (
        <div className="analyzers-row">
          <SpectrumAnalyzer syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={1} />
          <SpaceAnalyzer syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={1} />
          <VolumeIndicator syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={1} />
        </div>
      )}

      {/* Comments */}
      <div className="comments-section">
        <div className="comments-columns">
          {tracks.map((track, i) => {
            const comments = allComments[i] ?? []
            return (
              <div className="comments-column" key={track.id}>
                {tracks.length > 1 && <h3>Track {LABELS[i]}</h3>}

                <div className="comment-list">
                  {comments.length === 0 && (
                    <p className="empty-comments">No comments yet.</p>
                  )}
                  {comments.map((c) => (
                    <div className="comment-item" key={c.id}>
                      <div className="comment-meta">
                        <span className="comment-timestamp" role="button" onClick={() => {
                          if (duration > 0) {
                            seek(c.timestampSeconds / duration)
                            if (!isPlaying) {
                              play()
                              setIsPlaying(true)
                            }
                          }
                        }}>{formatTime(c.timestampSeconds)}</span>
                        <span className="comment-author">@{c.handle}</span>
                      </div>
                      <div className="comment-body">{c.body}</div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Help modal */}
      {showHelp && (
        <div className="modal-overlay" onClick={() => setShowHelp(false)} onKeyDown={(e) => { if (e.key === 'Escape') setShowHelp(false) }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="modal-close" onClick={() => setShowHelp(false)}>✕</button>
            <h2>Audius AB</h2>
            <p>Compare two tracks side-by-side. Listen, analyze, and leave timestamped comments.</p>

            <h3>How to use</h3>
            <ul>
              <li>Press play or hit <kbd>Space</kbd> to start playback</li>
              <li>Click a waveform to seek; click the other track's waveform to switch</li>
              <li>Double-click a waveform to set a comment timestamp and focus the input</li>
              <li>Use the analyzers (spectrum, stereo field, loudness) to compare tracks</li>
              <li>Log in with Audius to leave comments and favorite tracks</li>
            </ul>

            <h3>Hotkeys</h3>
            <table className="hotkeys-table">
              <tbody>
                <tr><td><kbd>Space</kbd></td><td>Play / Pause</td></tr>
                <tr><td><kbd>1</kbd> / <kbd>2</kbd></td><td>Switch to track A / B</td></tr>
                <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>Switch track</td></tr>
                <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>Seek ±5s (hold to fast-seek)</td></tr>
                <tr><td><kbd>C</kbd></td><td>Focus comment input at current time</td></tr>
                <tr><td><kbd>Enter</kbd></td><td>Submit comment</td></tr>
                <tr><td><kbd>Shift+Enter</kbd></td><td>New line in comment</td></tr>
                <tr><td><kbd>Escape</kbd></td><td>Unfocus comment input</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
