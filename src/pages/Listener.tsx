import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { decodeHashId } from '@audius/sdk'
import { getSDK } from '../lib/audius'
import { useSyncedWaveforms } from '../hooks/useSyncedWaveforms'
import SpectrumAnalyzer from '../components/SpectrumAnalyzer'
import SpaceAnalyzer from '../components/SpaceAnalyzer'
import VolumeIndicator from '../components/VolumeIndicator'
import RGBWaveform from '../components/RGBWaveform'
import ZoomedWaveform from '../components/ZoomedWaveform'

const LABELS = ['A', 'B']

function AvatarImg({ src, mirrors, alt }: { src: string; mirrors: string[]; alt: string }) {
  const tryMirror = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const tried = parseInt(img.dataset.mirrorIdx ?? '0', 10)
    if (tried < mirrors.length) {
      img.dataset.mirrorIdx = String(tried + 1)
      img.src = mirrors[tried]
    }
  }
  return <img src={src} alt={alt} onError={tryMirror} />
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

interface TrackInfo {
  id: string
  userId: string
  title: string
  artist: string
  streamUrl: string
}

interface CommentDisplay {
  id: string
  userId: string
  handle: string
  avatarUrl: string
  avatarMirrors: string[]
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
  const [showOverlay, setShowOverlay] = useState(false)
  const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null)

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
        const userMap = new Map(users.map((u: any) => [u.id, u]))
        return items.map((c) => {
          const user = c.userId ? userMap.get(c.userId) : null
          const pic = user?.profilePicture ?? user?.avatar
          let primaryUrl = ''
          let mirrorUrls: string[] = []
          if (typeof pic === 'string') {
            primaryUrl = pic
          } else if (pic) {
            // Keys are _150x150, _480x480, _1000x1000
            primaryUrl = pic._150x150 ?? pic._480x480 ?? pic._1000x1000 ?? ''
            // Mirrors are host prefixes — construct full URLs from the primary path
            if (primaryUrl && Array.isArray(pic.mirrors)) {
              try {
                const path = new URL(primaryUrl).pathname
                mirrorUrls = pic.mirrors.map((host: string) => `${host.replace(/\/$/, '')}${path}`)
              } catch { /* ignore */ }
            }
          }
          return {
            id: c.id,
            userId: c.userId ?? '',
            handle: user?.handle ?? c.userId ?? 'anon',
            avatarUrl: primaryUrl,
            avatarMirrors: mirrorUrls,
            body: c.message,
            timestampSeconds: c.trackTimestampS ?? 0,
          }
        })
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
  const trackIds = tracks.map((t) => t.id)

  const { isReady, currentTime, duration, trackDurations, colorData, bpms, play, pause, seek, setActive, syncedRef } =
    useSyncedWaveforms(streamUrls, trackIds, (time) => {
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
              userId: t.user?.id ?? '',
              title: t.title,
              artist: t.user?.name || t.user?.handle || '',
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
  const bpmsRef = useRef(bpms)
  bpmsRef.current = bpms
  const pauseRef = useRef(pause)
  pauseRef.current = pause

  // Hotkeys
  useEffect(() => {
    const FINE_NUDGE_SECS = 0.5

    /** 4 beats in seconds based on active track's BPM */
    function fourBeatsSecs(): number {
      const bpm = bpmsRef.current[activeIndexRef.current] || 120
      return (60 / bpm) * 4
    }
    const FF_INTERVAL_MS = 80
    const FF_SECS_PER_TICK = 0.5
    const HOLD_THRESHOLD_MS = 300
    let holdTimer: ReturnType<typeof setTimeout> | null = null
    let ffInterval: ReturnType<typeof setInterval> | null = null
    let didHold = false
    let wasShiftSeek = false

    function seekRelative(deltaSecs: number) {
      const dur = durationRef.current
      if (dur <= 0) return
      // Read real-time position from audio engine, not throttled React state
      const cur = syncedRef.current?.getCurrentTime() ?? currentTimeRef.current
      const newTime = Math.max(0, Math.min(dur, cur + deltaSecs))
      seekRef.current?.(newTime / dur)
    }

    const FF_SHIFT_MULTIPLIER = 4
    let shiftHeld = false

    function startFastSeek(dir: number) {
      if (ffInterval) return
      didHold = true
      ffInterval = setInterval(() => {
        const base = FF_SECS_PER_TICK
        seekRelative(dir * base * (shiftHeld ? FF_SHIFT_MULTIPLIER : 1))
      }, FF_INTERVAL_MS)
    }

    function stopFastSeek() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
      if (ffInterval) { clearInterval(ffInterval); ffInterval = null }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Shift') { shiftHeld = true; return }
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
        const dir = e.key === 'ArrowRight' ? 1 : -1
        if (e.repeat) return
        didHold = false
        wasShiftSeek = e.shiftKey
        shiftHeld = e.shiftKey
        holdTimer = setTimeout(() => startFastSeek(dir), HOLD_THRESHOLD_MS)
        return
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.key === 'Shift') { shiftHeld = false; return }
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = e.key === 'ArrowRight' ? 1 : -1
        stopFastSeek()
        if (!didHold) {
          if (wasShiftSeek) {
            seekRelative(dir * fourBeatsSecs())
          } else {
            seekRelative(dir * FINE_NUDGE_SECS)
          }
        }
        didHold = false
        wasShiftSeek = false
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
    // Only allow comments on tracks owned by the playlist creator
    if (!ownerId || !tracks[i] || tracks[i].userId !== ownerId) return null
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

  function scrollToComment(commentId: string) {
    const el = document.getElementById(`comment-${commentId}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightedCommentId(commentId)
    setTimeout(() => setHighlightedCommentId(null), 2000)
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
    <div className="page listener-page">
      <div className="listener-above-fold">
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

      {/* Analyzer overlay toggle */}
      {tracks.length > 1 && (
        <div className="analyzer-overlay-bar">
          <button
            type="button"
            className={`overlay-toggle${showOverlay ? ' active' : ''}`}
            onClick={() => setShowOverlay(v => !v)}
          >
            A/B Overlay
          </button>
        </div>
      )}

      {/* Track A Analyzers */}
      <div className="analyzers-row track-a">
        <SpectrumAnalyzer syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={0} accentColor="#e06030" otherAccentColor="#3080e0" showOverlay={showOverlay} />
        <SpaceAnalyzer syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={0} accentColor="#e06030" otherAccentColor="#3080e0" showOverlay={showOverlay} />
        <VolumeIndicator syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={0} accentColor="#e06030" otherAccentColor="#3080e0" showOverlay={showOverlay} />
      </div>

      {/* Waveform area */}
      <div className="waveform-area">
        <div className="waveform-area-center">

          {/* Track A */}
          {tracks.length > 0 && (
            <div className="waveform-track-group">
              {renderCommentForm(0)}
              <div className="waveform-time-row">
                <div className="comment-avatars-strip">
                  {(allComments[0] ?? []).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="comment-avatar-marker"
                      style={{ left: duration > 0 ? `${(c.timestampSeconds / duration) * 100}%` : '0%' }}
                      title={`@${c.handle}: ${c.body}`}
                      onClick={() => scrollToComment(c.id)}
                    >
                      {c.avatarUrl ? <AvatarImg src={c.avatarUrl} mirrors={c.avatarMirrors} alt="" /> : <span className="comment-avatar-fallback">{c.handle[0]?.toUpperCase()}</span>}
                    </button>
                  ))}
                </div>
                <span className="time-display">
                  {formatTime(Math.min(currentTime, trackDurations[0] ?? duration))} / {formatTime(trackDurations[0] ?? duration)}
                </span>
              </div>
              <div className={`waveform-row track-a${activeIndex === 0 ? ' active' : ''}`}>
                {tracks.length > 1 && (
                  <button
                    type="button"
                    className={`track-toggle-btn track-a${activeIndex === 0 ? ' active' : ''}`}
                    onClick={() => handleToggleTrack(0)}
                    title={`Listen to ${tracks[0].title || 'track A'}`}
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
                    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
                    clickTimerRef.current = setTimeout(() => {
                      clickTimerRef.current = null
                      handleToggleTrack(0)
                      if (duration > 0) seek(progress)
                    }, 250)
                  }}
                  onDoubleClick={(progress) => {
                    if (clickTimerRef.current) {
                      clearTimeout(clickTimerRef.current)
                      clickTimerRef.current = null
                    }
                    handleToggleTrack(0)
                    if (ownerId && tracks[0]?.userId === ownerId) {
                      setCommentTime(progress * duration)
                      skipFocusTimeRef.current = true
                      commentTextareaRefs.current[0]?.focus()
                    }
                  }}
                >
                  <div
                    className="comment-marker pending"
                    style={{
                      left: duration > 0 && commentTime !== null ? `${(commentTime / duration) * 100}%` : '0%',
                      display: commentTime !== null && commentTrackIdx === 0 ? undefined : 'none',
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
                  className={`btn-favorite${favorited.has(tracks[0].id) ? ' favorited' : ''}`}
                  onClick={() => handleFavorite(tracks[0].id)}
                  title="Favorite this track"
                >
                  ♥
                </button>
              </div>
            </div>
          )}

          {/* Track B */}
          {tracks.length > 1 && (
            <div className="waveform-track-group">
              <div className={`waveform-row track-b${activeIndex === 1 ? ' active' : ''}`}>
                {tracks.length > 1 && (
                  <button
                    type="button"
                    className={`track-toggle-btn track-b${activeIndex === 1 ? ' active' : ''}`}
                    onClick={() => handleToggleTrack(1)}
                    title={`Listen to ${tracks[1].title || 'track B'}`}
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
                    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
                    clickTimerRef.current = setTimeout(() => {
                      clickTimerRef.current = null
                      handleToggleTrack(1)
                      if (duration > 0) seek(progress)
                    }, 250)
                  }}
                  onDoubleClick={(progress) => {
                    if (clickTimerRef.current) {
                      clearTimeout(clickTimerRef.current)
                      clickTimerRef.current = null
                    }
                    handleToggleTrack(1)
                    if (ownerId && tracks[1]?.userId === ownerId) {
                      setCommentTime(progress * duration)
                      skipFocusTimeRef.current = true
                      commentTextareaRefs.current[1]?.focus()
                    }
                  }}
                >
                  <div
                    className="comment-marker pending"
                    style={{
                      left: duration > 0 && commentTime !== null ? `${(commentTime / duration) * 100}%` : '0%',
                      display: commentTime !== null && commentTrackIdx === 1 ? undefined : 'none',
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
                  className={`btn-favorite${favorited.has(tracks[1].id) ? ' favorited' : ''}`}
                  onClick={() => handleFavorite(tracks[1].id)}
                  title="Favorite this track"
                >
                  ♥
                </button>
              </div>
              <div className="waveform-time-row">
                <div className="comment-avatars-strip">
                  {(allComments[1] ?? []).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="comment-avatar-marker"
                      style={{ left: duration > 0 ? `${(c.timestampSeconds / duration) * 100}%` : '0%' }}
                      title={`@${c.handle}: ${c.body}`}
                      onClick={() => scrollToComment(c.id)}
                    >
                      {c.avatarUrl ? <AvatarImg src={c.avatarUrl} mirrors={c.avatarMirrors} alt="" /> : <span className="comment-avatar-fallback">{c.handle[0]?.toUpperCase()}</span>}
                    </button>
                  ))}
                </div>
                <span className="time-display">
                  {formatTime(Math.min(currentTime, trackDurations[1]))} / {formatTime(trackDurations[1])}
                </span>
              </div>
              {renderCommentForm(1)}
            </div>
          )}

        </div>
      </div>

      {/* Track B Analyzers */}
      {tracks.length > 1 && (
        <div className="analyzers-row track-b">
          <SpectrumAnalyzer syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={1} accentColor="#3080e0" otherAccentColor="#e06030" showOverlay={showOverlay} />
          <SpaceAnalyzer syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={1} accentColor="#3080e0" otherAccentColor="#e06030" showOverlay={showOverlay} />
          <VolumeIndicator syncedRef={syncedRef} isPlaying={isPlaying} trackIndex={1} accentColor="#3080e0" otherAccentColor="#e06030" showOverlay={showOverlay} />
        </div>
      )}

      </div>{/* end listener-above-fold */}

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
                    <div className={`comment-item${highlightedCommentId === c.id ? ' highlighted' : ''}`} id={`comment-${c.id}`} key={c.id}>
                      <div className="comment-meta">
                        <span className="comment-timestamp" role="button" onClick={() => {
                          if (duration > 0) {
                            setActive(i)
                            setActiveIndex(i)
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
            <p>Compare two tracks side-by-side with real-time audio analysis. Listen, analyze, and leave timestamped comments.</p>

            <h3>How to use</h3>
            <ul>
              <li>Press play or hit <kbd>Space</kbd> to start playback</li>
              <li>Click a waveform to seek; click the other track's waveform to switch &amp; seek</li>
              <li>Hover over a waveform to preview the seek position</li>
              <li>Double-click a waveform to set a comment timestamp</li>
              <li>Click a commenter's avatar on the waveform timeline to jump to their comment</li>
              <li>Toggle <strong>A/B Overlay</strong> to compare both tracks' analysis side-by-side</li>
              <li>Hover over the spectrum analyzer to see frequency, note, and dB at the cursor</li>
              <li>Use the analyzers to compare spectrum, stereo field (polar/Lissajous), and loudness (LUFS/peak/RMS)</li>
              <li>Log in with Audius to leave comments and favorite tracks</li>
            </ul>

            <h3>Hotkeys</h3>
            <table className="hotkeys-table">
              <tbody>
                <tr><td><kbd>Space</kbd></td><td>Play / Pause</td></tr>
                <tr><td><kbd>1</kbd> / <kbd>2</kbd></td><td>Switch to track A / B</td></tr>
                <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>Switch track</td></tr>
                <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>Nudge ±0.5s; hold to fast-seek; <kbd>Shift</kbd> for 4-beat jumps</td></tr>
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
