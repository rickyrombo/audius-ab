import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { decodeHashId } from '@audius/sdk'
import { getSDK } from '../lib/audius'
import { useSyncedWaveforms } from '../hooks/useSyncedWaveforms'
import SpectrumAnalyzer from '../components/SpectrumAnalyzer'
import SpaceAnalyzer from '../components/SpaceAnalyzer'
import VolumeIndicator from '../components/VolumeIndicator'

const LABELS = ['A', 'B', 'C', 'D']

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
  handle: string
  body: string
  timestampSeconds: number
}

export default function Listener() {
  const { playlistId } = useParams<{ playlistId: string }>()

  const [description, setDescription] = useState('')
  const [tracks, setTracks] = useState<TrackInfo[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentTrackIdx, setCommentTrackIdx] = useState(0)
  const [favorited, setFavorited] = useState<Set<string>>(new Set())
  const [submittingComment, setSubmittingComment] = useState(false)
  const [waveformPeaks, setWaveformPeaks] = useState<number[][]>([])

  const containerRefs = useRef<(HTMLDivElement | null)[]>([])
  const queryClient = useQueryClient()

  const activeTrackId = tracks[commentTrackIdx]?.id
  const { data: comments = [] } = useQuery({
    queryKey: ['comments', activeTrackId],
    queryFn: async (): Promise<CommentDisplay[]> => {
      if (!activeTrackId) return []
      const sdk = getSDK()
      const resp = await sdk.tracks.getTrackComments({ trackId: activeTrackId })
      const items = resp.data ?? []
      const users = resp.related?.users ?? []
      const handleMap = new Map(users.map((u) => [u.id, u.handle]))
      return items.map((c) => ({
        id: c.id,
        handle: (c.userId && handleMap.get(c.userId)) ?? c.userId ?? 'anon',
        body: c.message,
        timestampSeconds: c.trackTimestampS ?? 0,
      }))
    },
    enabled: !!activeTrackId,
    staleTime: Infinity,
  })

  const streamUrls = tracks.map((t) => t.streamUrl)

  const { isReady, currentTime, duration, play, pause, seek, setActive, syncedRef } =
    useSyncedWaveforms(containerRefs, streamUrls, waveformPeaks.length === streamUrls.length ? waveformPeaks : undefined)

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

        // Fetch tracks with stream URLs
        const trackItems = playlist.tracks ?? []
        if (!trackItems.length) throw new Error('No tracks in playlist')
        if (cancelled) return

        const trackInfos: TrackInfo[] = trackItems.map((t) => ({
          id: t.id,
          title: t.title,
          streamUrl: t.stream?.url ?? t.stream?.mirrors?.[0] ?? '',
        }))

        // Fetch waveform data from Phoenix API
        const numericIds = trackItems.map((t) => decodeHashId(t.id))
        try {
          const waveforms = await Promise.all(
            numericIds.map(async (numId) => {
              const resp = await fetch(`/api/phoenix/tracks?id=${numId}`)
              const json = await resp.json()
              return json.data?.[0]?.waveform as number[] | undefined
            })
          )
          if (!cancelled) {
            const validPeaks = waveforms.filter((w): w is number[] => Array.isArray(w))
            if (validPeaks.length === trackInfos.length) {
              setWaveformPeaks(validPeaks)
            }
          }
        } catch {
          // Waveform fetch failed — will fall back to client-side decoding
        }

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

      const numIdx = ['1', '2', '3', '4'].indexOf(e.key)
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
    return sdk.oauth.getUser()
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
          trackTimestampS: Math.floor(currentTime),
        },
      })

      setCommentText('')
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
        <h1>Audius AB</h1>
      </div>

      {description && <p className="listener-question">{description}</p>}

      {!isReady && (
        <p className="loading-msg">Fetching and decoding audio…</p>
      )}

      {/* Track rows */}
      <div className="track-rows">
        {tracks.map((track, i) => (
          <div
            className={`waveform-row${activeIndex === i ? ' active' : ''}`}
            key={track.id}
          >
            <button
              type="button"
              className={`track-toggle-btn${activeIndex === i ? ' active' : ''}`}
              onClick={() => handleToggleTrack(i)}
              title={`Listen to ${track.title || `track ${LABELS[i]}`}`}
            >
              {LABELS[i]}
            </button>
            <div
              ref={(el) => { containerRefs.current[i] = el }}
              className="waveform-container"
            >
              {/* Comment markers */}
              {duration > 0 &&
                comments
                  .filter(() => commentTrackIdx === i)
                  .map((c) => (
                    <div
                      key={c.id}
                      className="comment-marker"
                      style={{ left: `${(c.timestampSeconds / duration) * 100}%` }}
                      title={`${c.handle}: ${c.body}`}
                    />
                  ))}
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
        ))}
      </div>

      {/* Transport */}
      <div className="transport">
        <button
          type="button"
          className="btn-playpause"
          onClick={handlePlayPause}
          disabled={!isReady}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <span className="time-display">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>

      {/* Analyzers */}
      {isReady && (
        <div className="analyzers-row">
          <SpectrumAnalyzer syncedRef={syncedRef} isPlaying={isPlaying} />
          <SpaceAnalyzer syncedRef={syncedRef} isPlaying={isPlaying} />
          <VolumeIndicator syncedRef={syncedRef} isPlaying={isPlaying} />
        </div>
      )}

      {/* Comments */}
      <div className="comments-section">
        <h3>Comments — Track {LABELS[commentTrackIdx] ?? commentTrackIdx + 1}</h3>

        <div className="comment-form">
          <textarea
            placeholder={`Comment at ${formatTime(currentTime)}… (requires Audius login)`}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            disabled={submittingComment}
          />
          <button
            type="button"
            className="btn-comment"
            onClick={handleComment}
            disabled={!commentText.trim() || submittingComment}
          >
            {submittingComment ? 'Posting…' : 'Post'}
          </button>
        </div>

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
    </div>
  )
}
