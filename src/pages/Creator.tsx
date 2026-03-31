import { useState, useRef, useId } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSDK } from '../lib/audius'
import { Genre } from '@audius/sdk/src/sdk/api/generated/default/models/Genre'

const LABELS = ['A', 'B', 'C', 'D']
const MAX_SLOTS = 4

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || /\.(mp3|wav|flac|aiff?|ogg|m4a|aac)$/i.test(file.name)
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

interface TrackSlot {
  id: string
  file: File | null
  title: string
  uploadedTrackId: string | null
  progress: 'idle' | 'uploading' | 'done' | 'error'
  uploadPct: number
}

function makeSlot(id: string): TrackSlot {
  return { id, file: null, title: '', uploadedTrackId: null, progress: 'idle', uploadPct: 0 }
}

export default function Creator() {
  const uid = useId()
  const counter = useRef(0)
  const nextId = () => `${uid}-${counter.current++}`

  const [slots, setSlots] = useState<TrackSlot[]>([makeSlot(nextId())])
  const [question, setQuestion] = useState('')
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const navigate = useNavigate()

  // Slots that have a file
  const filledSlots = slots.filter((s) => s.file !== null)
  // Whether to show the empty slot (for adding more)
  const showEmptySlot = filledSlots.length < MAX_SLOTS

  function setSlot(id: string, patch: Partial<TrackSlot>) {
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function handleFileDrop(slotId: string, file: File) {
    if (!isAudioFile(file)) return
    setSlot(slotId, { file, title: stripExt(file.name) })
    // If this was the empty slot, append another empty one (if under max)
    setSlots((prev) => {
      const updated = prev.map((s) => (s.id === slotId ? { ...s, file, title: stripExt(file.name) } : s))
      const filled = updated.filter((s) => s.file !== null)
      if (filled.length < MAX_SLOTS) {
        return [...updated, makeSlot(nextId())]
      }
      return updated
    })
  }

  function handleFileInput(slotId: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFileDrop(slotId, file)
    e.target.value = ''
  }

  function removeSlot(slotId: string) {
    setSlots((prev) => {
      const without = prev.filter((s) => s.id !== slotId)
      // Ensure there's always one empty slot if under max
      const filled = without.filter((s) => s.file !== null)
      if (filled.length < MAX_SLOTS && !without.some((s) => s.file === null)) {
        return [...without, makeSlot(nextId())]
      }
      return without
    })
  }

  async function handleCreate() {
    if (filledSlots.length < 1) {
      setStatusMsg('Add at least 1 track.')
      return
    }
    setPhase('uploading')
    setStatusMsg('')

    const sdk = getSDK()

    try {
      // Auth
      const isAuth = await sdk.oauth.isAuthenticated()
      if (!isAuth) {
        setStatusMsg('Opening Audius login…')
        await sdk.oauth.login({ scope: 'write' })
      }
      const user = await sdk.oauth.getUser()
      setStatusMsg(`Logged in as @${user.handle}`)

      // Upload tracks in parallel
      setStatusMsg('Uploading tracks…')
      const trackIds = await Promise.all(
        filledSlots.map((slot, i) => {
          const slotId = slot.id
          const updateProgress = (pct: number) => {
            setSlots((prev) =>
              prev.map((s) =>
                s.id === slotId ? { ...s, progress: 'uploading' as const, uploadPct: pct } : s
              )
            )
          }

          // Step 1: Upload audio
          const upload = sdk.uploads.createAudioUpload({
            file: slot.file!,
            onProgress: ({ loaded, total }) => updateProgress((loaded / total) * 100),
          })

          return upload.start().then(async (uploadResult) => {
            const { trackCid, origFileCid, duration } = uploadResult
            if (!trackCid) throw new Error('Upload failed: no trackCid')

            // Step 2: Create track on-chain
            const result = await sdk.tracks.createTrack({
              userId: user.id,
              metadata: {
                title: slot.title || LABELS[i] || `Track ${i + 1}`,
                genre: Genre.Electronic,
                isUnlisted: true,
                trackCid,
                origFileCid,
                duration,
              },
            })
            if (!result.trackId) throw new Error(`Track creation failed for "${slot.title}"`)

            setSlots((prev) =>
              prev.map((s) =>
                s.id === slotId ? { ...s, progress: 'done' as const, uploadedTrackId: result.trackId!, uploadPct: 100 } : s
              )
            )
            return result.trackId
          })
        })
      )

      // Create playlist
      setStatusMsg('Creating playlist…')
      const now = Math.floor(Date.now() / 1000)
      const result = await sdk.playlists.createPlaylist({
        userId: user.id,
        metadata: {
          playlistName: `AB: ${question.trim().slice(0, 50) || 'Untitled'}`,
          description: question.trim() || undefined,
          isPrivate: true,
          playlistContents: trackIds.map((id) => ({ trackId: id, timestamp: now })),
        },
      })
      if (!result.playlistId) throw new Error('Playlist creation failed')

      const url = `${window.location.origin}/listen/${result.playlistId}`
      setGeneratedUrl(url)
      setPhase('done')
      setStatusMsg('')
    } catch (err) {
      setPhase('error')
      setStatusMsg(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  function handleCopy() {
    if (!generatedUrl) return
    navigator.clipboard.writeText(generatedUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const canCreate = filledSlots.length >= 1 && phase === 'idle'

  return (
    <div className="page">
      <div className="page-header">
        <h1>Audius AB</h1>
        <p>Upload 1–4 tracks and get feedback on your mix.</p>
      </div>

      <div className="creator-slots">
        {slots.map((slot, i) => {
          const label = LABELS[i] ?? `${i + 1}`
          const isEmpty = slot.file === null
          if (isEmpty && !showEmptySlot) return null
          return (
            <Dropzone
              key={slot.id}
              slot={slot}
              label={label}
              isEmpty={isEmpty}
              onFile={(file) => handleFileDrop(slot.id, file)}
              onInputChange={(e) => handleFileInput(slot.id, e)}
              onRemove={() => removeSlot(slot.id)}
              onTitleChange={(title) => setSlot(slot.id, { title })}
            />
          )
        })}
      </div>

      <div className="field">
        <label htmlFor="question">Feedback Question</label>
        <textarea
          id="question"
          placeholder="Which mix translates better on small speakers?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={phase === 'uploading'}
        />
      </div>

      {phase !== 'done' && (
        <button
          type="button"
          className="btn-primary"
          onClick={handleCreate}
          disabled={!canCreate}
        >
          {phase === 'uploading' ? 'Creating…' : 'Create Link'}
        </button>
      )}

      {statusMsg && (
        <p className={`status-msg${phase === 'error' ? ' error' : ''}`}>{statusMsg}</p>
      )}

      {generatedUrl && (
        <div className="result-box">
          <p>Share this link with listeners:</p>
          <div className="result-url">
            <label htmlFor="generated-url" className="sr-only">Generated URL</label>
            <input id="generated-url" type="text" readOnly value={generatedUrl} aria-label="Generated sharing URL" />
            <button type="button" className="btn-copy" onClick={handleCopy} aria-label="Copy URL to clipboard">
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="result-actions">
            <button type="button" className="btn-secondary" onClick={() => navigate(`/listen/${generatedUrl.split('/listen/')[1]}`)}>
              Open Link
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

interface DropzoneProps {
  slot: TrackSlot
  label: string
  isEmpty: boolean
  onFile: (file: File) => void
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemove: () => void
  onTitleChange: (title: string) => void
}

function Dropzone({ slot, label, isEmpty, onFile, onInputChange, onRemove, onTitleChange }: DropzoneProps) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }

  if (isEmpty) {
    return (
      <div
        className={`dropzone${dragOver ? ' drag-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <div className="dropzone-label">Track {label}</div>
        <div className="dropzone-prompt">Drop audio file here or click to browse</div>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          onChange={onInputChange}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Upload audio file for track ${label}`}
        />
      </div>
    )
  }

  return (
    <div className="dropzone has-file">
      <div className="dropzone-filename">
        <span className="label-badge">{label}</span>
        <label htmlFor={`track-title-${slot.id}`} className="sr-only">Track title</label>
        <input
          id={`track-title-${slot.id}`}
          type="text"
          value={slot.title}
          onChange={(e) => onTitleChange(e.target.value)}
          className="track-title-input"
          placeholder="Track title"
        />
        <button type="button" className="dropzone-remove" onClick={onRemove} title="Remove">×</button>
      </div>
      {slot.progress === 'uploading' && (
        <div className="progress-bar-wrap">
          <div className="progress-bar" style={{ width: `${slot.uploadPct}%` }} />
        </div>
      )}
      {slot.progress === 'done' && (
        <div className="upload-done">✓ Uploaded</div>
      )}
    </div>
  )
}
