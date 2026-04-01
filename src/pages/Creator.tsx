import { useState, useRef, useId } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { getSDK } from '../lib/audius'
import { Genre } from '@audius/sdk/src/sdk/api/generated/default/models/Genre'

const LABELS = ['A', 'B']
const MAX_SLOTS = 2

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
  const [copied, setCopied] = useState(false)
  const navigate = useNavigate()

  const mutation = useMutation({
    mutationFn: async () => {
      const filled = slots.filter((s) => s.file !== null)
      if (filled.length < 1) throw new Error('Add at least one track.')

      const sdk = getSDK()

      const isAuth = await sdk.oauth.isAuthenticated()
      if (!isAuth) await sdk.oauth.login({ scope: 'write' })
      const user = await sdk.oauth.getUser()

      const trackIds = await Promise.all(
        filled.map((slot, i) => {
          const slotId = slot.id
          const updateProgress = (pct: number) => {
            setSlots((prev) =>
              prev.map((s) =>
                s.id === slotId ? { ...s, progress: 'uploading' as const, uploadPct: pct } : s
              )
            )
          }

          const upload = sdk.uploads.createAudioUpload({
            file: slot.file!,
            onProgress: ({ loaded, total }) => updateProgress((loaded / total) * 100),
          })

          return upload.start().then(async (uploadResult) => {
            const { trackCid, origFileCid, duration } = uploadResult
            if (!trackCid) throw new Error('Upload failed: no trackCid')

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

      const now = Math.floor(Date.now() / 1000)
      const titles = filled.map((s) => s.title)
      const defaultName = titles.length >= 2
        ? `A/B Test: ${titles[0]} vs ${titles[1]}`
        : `Feedback Request: ${titles[0]}`
      const result = await sdk.playlists.createPlaylist({
        userId: user.id,
        metadata: {
          playlistName: defaultName,
          description: question.trim() || undefined,
          isPrivate: true,
          playlistContents: trackIds.map((id) => ({ trackId: id, timestamp: now })),
        },
      })
      if (!result.playlistId) throw new Error('Playlist creation failed')

      return `${window.location.origin}/listen/${result.playlistId}`
    },
  })

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

  function handleCopy() {
    if (!mutation.data) return
    navigator.clipboard.writeText(mutation.data)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="page creator-page">
      <div className="page-header creator-header">
        <h1>Audius A/B</h1>
        <p>Upload 1–2 tracks and get a private link you can share that makes it easy for listeners to give feedback and compare your tracks.</p>
        <p>Ideal for A/B testing two versions of a track. Use it to get feedback on two different masters, a change in the mix, or a tweak of an element of your track.</p>
        <p>Examples: <a href="/listen/EJmKJXo" target="_blank" rel="noopener noreferrer">Single Track Feedback</a> | <a href="/listen/qz2gQwo" target="_blank" rel="noopener noreferrer">A/B Test</a></p>
      </div>

      <div className="creator-slots">
        {slots.map((slot, i) => {
          const label = LABELS[i] ?? `${i + 1}`
          const isEmpty = slot.file === null
          if (isEmpty && (!showEmptySlot || mutation.isPending || mutation.isSuccess)) return null
          return (
            <Dropzone
              key={slot.id}
              slot={slot}
              label={label}
              isEmpty={isEmpty}
              disabled={mutation.isPending}
              done={mutation.isSuccess}
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
          disabled={mutation.isPending}
        />
      </div>

      {!mutation.isSuccess && (
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
          <p>Share this link with listeners:</p>
          <div className="result-url">
            <input id="generated-url" type="text" readOnly value={mutation.data} aria-label="Generated sharing URL" />
            <button type="button" className="btn-copy" onClick={handleCopy} aria-label="Copy URL to clipboard">
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => navigate(`/listen/${mutation.data.split('/listen/')[1]}`)}>
              View
            </button>
          </div>
        </div>
      ): null}
    </div>
  )
}

interface DropzoneProps {
  slot: TrackSlot
  label: string
  isEmpty: boolean
  disabled: boolean
  done: boolean
  onFile: (file: File) => void
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemove: () => void
  onTitleChange: (title: string) => void
}

function Dropzone({ slot, label, isEmpty, disabled, done, onFile, onInputChange, onRemove, onTitleChange }: DropzoneProps) {
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
        {done ? (
          <span className="track-title-text">{slot.title}</span>
        ) : (
          <>
            <label htmlFor={`track-title-${slot.id}`} className="sr-only">Track title</label>
            <input
              id={`track-title-${slot.id}`}
              type="text"
              value={slot.title}
              onChange={(e) => onTitleChange(e.target.value)}
              className="track-title-input"
              placeholder="Track title"
              disabled={disabled}
            />
          </>
        )}
        {slot.progress === 'done' ? (
          <span className="dropzone-status-icon done" title="Uploaded">✓</span>
        ) : slot.progress === 'uploading' ? (
          <span className="dropzone-status-icon"><span className="spinner spinner-md" /></span>
        ) : (
          <button type="button" className="dropzone-remove" onClick={onRemove} title="Remove">×</button>
        )}
      </div>
      {slot.progress === 'uploading' && (
        <progress className="upload-progress" value={slot.uploadPct} max={100} />
      )}
    </div>
  )
}
