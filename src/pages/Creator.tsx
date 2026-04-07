import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { getSDK } from '../lib/audius'
import { useAuth } from '../hooks/useAuth'

import { Genre } from '@audius/sdk/src/sdk/api/generated/default/models/Genre'
import { getStreamUrl } from '../lib/streamUrl'

const LABELS = ['A', 'B']

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || /\.(mp3|wav|flac|aiff?|ogg|m4a|aac)$/i.test(file.name)
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

interface TrackEntry {
  key: number
  type: 'file' | 'existing'
  file?: File
  existingTrackId?: string
  title: string
  progress: 'idle' | 'uploading' | 'done' | 'error'
  uploadPct: number
}

interface SearchResult {
  id: string
  title: string
  handle: string
  streamUrl: string
}

export default function Creator() {
  const keyCounter = useRef(0)
  const nextKey = () => ++keyCounter.current

  const [tracks, setTracks] = useState<TrackEntry[]>([])
  const [playlistName, setPlaylistName] = useState('')
  const [question, setQuestion] = useState('')
  const [copied, setCopied] = useState(false)
  const navigate = useNavigate()
  const { currentUserHandle, checkAuth, ensureUser, logout } = useAuth()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => { checkAuth() }, [checkAuth])

  const isFull = tracks.length >= 2

  function clearError() { if (mutation.isError) mutation.reset() }

  function addFiles(files: FileList | File[]) {
    clearError()
    const remaining = 2 - tracks.length
    if (remaining <= 0) return
    const audioFiles = Array.from(files).filter(isAudioFile).slice(0, remaining)
    setTracks((prev) => [
      ...prev,
      ...audioFiles.map((f) => ({
        key: nextKey(),
        type: 'file' as const,
        file: f,
        title: stripExt(f.name),
        progress: 'idle' as const,
        uploadPct: 0,
      })),
    ])
  }

  function addExistingTrack(trackId: string, title: string) {
    clearError()
    if (tracks.length >= 2) return
    if (tracks.some((t) => t.existingTrackId === trackId)) return
    setTracks((prev) => [
      ...prev,
      {
        key: nextKey(),
        type: 'existing',
        existingTrackId: trackId,
        title,
        progress: 'idle',
        uploadPct: 0,
      },
    ])
  }

  function removeTrack(key: number) {
    clearError()
    setTracks((prev) => prev.filter((t) => t.key !== key))
  }

  function updateTitle(key: number, title: string) {
    setTracks((prev) => prev.map((t) => (t.key === key ? { ...t, title } : t)))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (tracks.length < 2) throw new Error('Both tracks are required.')

      const sdk = getSDK()

      const needsUpload = tracks.some((t) => t.type === 'file')
      if (needsUpload) {
        const isAuth = await sdk.oauth.isAuthenticated()
        if (!isAuth) await sdk.oauth.login({ scope: 'write' })
      }
      const meResp = await sdk.users.getMe()
      const user = meResp.data!

      const trackIds = await Promise.all(
        tracks.map((track, i) => {
          if (track.type === 'existing' && track.existingTrackId) {
            setTracks((prev) =>
              prev.map((t) =>
                t.key === track.key ? { ...t, progress: 'done' as const, uploadPct: 100 } : t
              )
            )
            return track.existingTrackId
          }

          const trackKey = track.key
          const updateProgress = (pct: number) => {
            setTracks((prev) =>
              prev.map((t) =>
                t.key === trackKey ? { ...t, progress: 'uploading' as const, uploadPct: pct } : t
              )
            )
          }

          const upload = sdk.uploads.createAudioUpload({
            file: track.file!,
            onProgress: ({ loaded, total }) => updateProgress((loaded / total) * 100),
          })

          return upload.start().then(async (uploadResult) => {
            const { trackCid, origFileCid, duration } = uploadResult
            if (!trackCid) throw new Error('Upload failed: no trackCid')

            const result = await sdk.tracks.createTrack({
              userId: user.id,
              metadata: {
                title: track.title || LABELS[i] || `Track ${i + 1}`,
                genre: Genre.Electronic,
                isUnlisted: true,
                trackCid,
                origFileCid,
                duration,
              },
            })
            if (!result.trackId) throw new Error(`Track creation failed for "${track.title}"`)

            setTracks((prev) =>
              prev.map((t) =>
                t.key === trackKey ? { ...t, progress: 'done' as const, uploadPct: 100 } : t
              )
            )
            return result.trackId
          })
        })
      )

      const now = Math.floor(Date.now() / 1000)
      const result = await sdk.playlists.createPlaylist({
        userId: user.id,
        metadata: {
          playlistName: playlistName.trim() || 'A/B Test',
          description: (question.trim() ? question.trim() + '\n' : '') + 'Made with Audius A/B',
          isPrivate: true,
          playlistContents: trackIds.map((id) => ({ trackId: id, timestamp: now })),
        },
      })
      if (!result.playlistId) throw new Error('Playlist creation failed')

      return result.playlistId
    },
  })

  const listenUrl = mutation.data ? `${window.location.origin}/analyze/${mutation.data}` : ''
  const blindUrl = mutation.data ? `${window.location.origin}/blind/${mutation.data}` : ''

  function handleCopy(url: string) {
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const done = mutation.isSuccess

  return (
    <div className="page creator-page">
      <div className="header-actions">
        {currentUserHandle ? (
          <>
            <Link to="/projects" className="user-handle-text">@{currentUserHandle}</Link>
            <button
              type="button"
              className="btn-header btn-logout"
              onClick={() => { logout().catch(() => {}) }}
              title="Log out"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            onClick={() => { ensureUser().catch(() => {}) }}
            title="Log in with Audius"
          >
            Log in
          </button>
        )}
      </div>
      <div className="page-header creator-header">
        <h1>Audius A/B</h1>
        <p>Compare two tracks side-by-side with real-time audio analysis. Upload or choose two tracks and get a private link to share with listeners.</p>
        <p>Ideal for A/B testing two versions of a track — compare different masters, mix changes, or tweaks to elements of your track.</p>
        <p>Examples: <a href="/analyze/r9b6J6O" target="_blank" rel="noopener noreferrer">Analyze</a> | <a href="/blind/r9b6J6O" target="_blank" rel="noopener noreferrer">Blind Test</a></p>
      </div>

      <div className="field">
        <label htmlFor="playlist-name">Project Name <span className="label-optional">(optional)</span></label>
        <input
          id="playlist-name"
          type="text"
          placeholder="A/B Test"
          value={playlistName}
          onChange={(e) => setPlaylistName(e.target.value)}
          disabled={mutation.isPending || done}
        />
      </div>

      <div className="field">
        <label htmlFor="question">Feedback Question <span className="label-optional">(optional)</span></label>
        <textarea
          id="question"
          placeholder="Which mix translates better on small speakers?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={mutation.isPending || done}
        />
      </div>

      <div className="field">
        <label>Tracks</label>
        {tracks.length > 0 && (
          <div className="selected-tracks">
            {tracks.map((track, i) => (
              <div key={track.key} className="selected-track">
                <span className="label-badge">{LABELS[i]}</span>
                {done || track.type === 'existing' || mutation.isPending ? (
                  <span className="track-title-text">{track.title}</span>
                ) : (
                  <input
                    type="text"
                    value={track.title}
                    onChange={(e) => updateTitle(track.key, e.target.value)}
                    className="track-title-input"
                    placeholder="Track title"
                  />
                )}
                {track.progress === 'done' ? (
                  <span className="dropzone-status-icon done" title="Done">✓</span>
                ) : track.progress === 'uploading' ? (
                  <span className="dropzone-status-icon"><span className="spinner spinner-md" /></span>
                ) : !done ? (
                  <button type="button" className="dropzone-remove" onClick={() => removeTrack(track.key)} title="Remove">×</button>
                ) : null}
                {track.progress === 'uploading' && (
                  <progress className="upload-progress" value={track.uploadPct} max={100} />
                )}
              </div>
            ))}
          </div>
        )}
        {!isFull && !done && !mutation.isPending && (
          <div className="track-picker">
            <div
              className={`dropzone${dragOver ? ' drag-over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}
              onClick={() => inputRef.current?.click()}
            >
              <div className="dropzone-prompt">
                {tracks.length === 0
                  ? 'Drop two audio files here or click to browse'
                  : 'Drop another audio file or click to browse'}
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="audio/*"
                multiple
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
                onClick={(e) => e.stopPropagation()}
                aria-label="Upload audio files"
              />
            </div>
            <div className="dropzone-divider"><span>or search Audius</span></div>
            <TrackSearch
              onSelect={addExistingTrack}
              disabledIds={tracks.filter((t) => t.existingTrackId).map((t) => t.existingTrackId!)}
            />
          </div>
        )}
      </div>

      {!done && (
        <button
          type="button"
          className="btn-primary"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? <><span className="spinner spinner-btn" /> Creating…</> : 'Create Link'}
        </button>
      )}

      {mutation.isError && (
        <p className="status-msg error">{mutation.error.message}</p>
      )}

      {mutation.data ? (
        <div className="result-box">
          <p>Share these links with listeners:</p>
          <div className="result-link-group">
            <label>Analysis</label>
            <div className="result-url">
              <input type="text" readOnly value={listenUrl} aria-label="Comparison URL" />
              <button type="button" className="btn-copy" onClick={() => handleCopy(listenUrl)}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => navigate(`/analyze/${mutation.data}`)}>
                View
              </button>
            </div>
          </div>
          <div className="result-link-group">
            <label>Blind Test</label>
            <div className="result-url">
              <input type="text" readOnly value={blindUrl} aria-label="Blind test URL" />
              <button type="button" className="btn-copy" onClick={() => handleCopy(blindUrl)}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => navigate(`/blind/${mutation.data}`)}>
                View
              </button>
            </div>
          </div>
        </div>
      ): null}
    </div>
  )
}

function TrackSearch({ onSelect, disabledIds }: { onSelect: (trackId: string, title: string) => void; disabledIds: string[] }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => { audioRef.current?.pause(); audioRef.current = null }
  }, [])

  const togglePreview = useCallback((r: SearchResult) => {
    if (previewId === r.id) {
      audioRef.current?.pause()
      audioRef.current = null
      setPreviewId(null)
      return
    }
    audioRef.current?.pause()
    if (!r.streamUrl) return
    const audio = new Audio(r.streamUrl)
    audio.volume = 0.5
    audio.play().catch(() => {})
    audio.addEventListener('ended', () => setPreviewId(null))
    audioRef.current = audio
    setPreviewId(r.id)
  }, [previewId])

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return }
    setLoading(true)
    try {
      const sdk = getSDK()
      const resp = await sdk.tracks.searchTracks({ query: q, limit: 8 })
      setResults(
        (resp.data ?? []).map((t) => ({
          id: t.id,
          title: t.title,
          handle: t.user?.handle ?? '',
          streamUrl: getStreamUrl(t.stream),
        }))
      )
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      audioRef.current?.pause()
      audioRef.current = null
      setPreviewId(null)
      doSearch(query)
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, doSearch])

  return (
    <div className="track-search">
      <input
        type="text"
        className="track-search-input"
        placeholder="Search for a track on Audius..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && <div className="track-search-loading"><div className="spinner spinner-sm" /></div>}
      {results.length > 0 && (
        <div className="track-search-results">
          {results.map((r) => {
            const isAdded = disabledIds.includes(r.id)
            return (
              <div key={r.id} className={`track-search-result${isAdded ? ' added' : ''}`}>
                <button
                  type="button"
                  className={`track-preview-btn${previewId === r.id ? ' playing' : ''}`}
                  onClick={() => togglePreview(r)}
                  title={previewId === r.id ? 'Stop preview' : 'Preview'}
                >
                  {previewId === r.id ? '■' : '▶'}
                </button>
                <button
                  type="button"
                  className="track-search-result-select"
                  disabled={isAdded}
                  onClick={() => { audioRef.current?.pause(); audioRef.current = null; setPreviewId(null); onSelect(r.id, r.title) }}
                >
                  <span className="track-search-title">{r.title}</span>
                  <span className="track-search-handle">{isAdded ? '✓ Added' : `@${r.handle}`}</span>
                </button>
              </div>
            )
          })}
        </div>
      )}
      {!loading && query.trim() && results.length === 0 && (
        <div className="track-search-empty">No tracks found</div>
      )}
    </div>
  )
}
