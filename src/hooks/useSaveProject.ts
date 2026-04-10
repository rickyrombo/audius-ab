import { useState, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getSDK } from '../lib/audius'
import { Genre } from '@audius/sdk/src/sdk/api/generated/default/models/Genre'
import { setCachedAudio, setCachedWaveform } from '../lib/audioCache'
import type { WaveformColorData } from '../lib/waveformAnalysis'

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || /\.(mp3|wav|flac|aiff?|ogg|m4a|aac)$/i.test(file.name)
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

const LABELS = ['A', 'B']

export interface TrackEntry {
  key: number
  file: File
  title: string
  progress: 'idle' | 'uploading' | 'done' | 'error'
  uploadPct: number
}

export interface SaveParams {
  name: string
  question: string
  /** When updating an existing project */
  existingPlaylistId?: string
  /** Existing track IDs in playlist order (for update) */
  existingTrackIds?: string[]
  /** Local file overrides by slot index (for replacing tracks in view mode) */
  localOverrides?: Record<number, File>
  /** Track IDs whose comments should be cleared after replacing audio */
  clearCommentTrackIds?: string[]
  /** Precomputed waveform color data by slot index, for preseeding cache */
  waveformColorData?: (WaveformColorData | null)[]
}

export function useSaveProject() {
  const keyCounter = useRef(0)
  const nextKey = () => ++keyCounter.current
  const queryClient = useQueryClient()

  const [tracks, setTracks] = useState<TrackEntry[]>([])

  function addFiles(files: FileList | File[]) {
    if (mutation.isError) mutation.reset()
    const remaining = 2 - tracks.length
    if (remaining <= 0) return
    const audioFiles = Array.from(files).filter(isAudioFile).slice(0, remaining)
    setTracks((prev) => [
      ...prev,
      ...audioFiles.map((f) => ({
        key: nextKey(),
        file: f,
        title: stripExt(f.name),
        progress: 'idle' as const,
        uploadPct: 0,
      })),
    ])
  }

  function removeTrack(key: number) {
    if (mutation.isError) mutation.reset()
    setTracks((prev) => prev.filter((t) => t.key !== key))
  }

  function replaceTrack(slot: number, file: File) {
    if (mutation.isError) mutation.reset()
    const entry: TrackEntry = {
      key: nextKey(),
      file,
      title: stripExt(file.name),
      progress: 'idle',
      uploadPct: 0,
    }
    setTracks((prev) => {
      const next = [...prev]
      next[slot] = entry
      return next
    })
  }

  async function uploadFile(
    sdk: ReturnType<typeof getSDK>,
    file: File,
    onProgress: (pct: number) => void,
  ) {
    const upload = sdk.uploads.createAudioUpload({
      file,
      onProgress: ({ loaded, total }) => onProgress((loaded / total) * 100),
    })
    const result = await upload.start()
    const { trackCid, origFileCid, duration } = result
    if (!trackCid) throw new Error('Upload failed: no trackCid')
    return { trackCid, origFileCid: origFileCid!, duration: duration! }
  }

  async function deleteCommentsForTrack(
    sdk: ReturnType<typeof getSDK>,
    userId: string,
    trackId: string,
  ) {
    try {
      const resp = await sdk.tracks.getTrackComments({ trackId })
      const comments = resp.data ?? []
      for (const comment of comments) {
        await sdk.comments.deleteComment({ commentId: comment.id, userId })
      }
    } catch {
      // Best-effort: ignore errors clearing comments
    }
  }

  const mutation = useMutation({
    mutationFn: async (params: SaveParams) => {
      const { name, question, existingPlaylistId, existingTrackIds, localOverrides, clearCommentTrackIds, waveformColorData } = params

      const sdk = getSDK()
      const isAuth = await sdk.oauth.isAuthenticated()
      if (!isAuth) await sdk.oauth.login({ scope: 'write' })
      const meResp = await sdk.users.getMe()
      const user = meResp.data!
      const descriptionText = (question.trim() ? question.trim() + '\n' : '') + 'Made with Audius A/B'

      // ── UPDATE existing project ──
      if (existingPlaylistId && existingTrackIds) {
        const finalTrackIds = [...existingTrackIds]

        // Replace tracks that have local overrides
        if (localOverrides) {
          for (const [slotStr, file] of Object.entries(localOverrides)) {
            const slot = Number(slotStr)
            const existingTrackId = existingTrackIds[slot]

            const { trackCid, origFileCid, duration } = await uploadFile(sdk, file, () => {})

            if (existingTrackId) {
              // Update existing track with new audio
              await sdk.tracks.updateTrack({
                trackId: existingTrackId,
                userId: user.id,
                metadata: {
                  trackCid,
                  origFileCid,
                  duration,
                  title: stripExt(file.name),
                },
              })
              // Preseed IDB caches with new audio + waveform data
              setCachedAudio(existingTrackId, await file.arrayBuffer())
              const waveform = waveformColorData?.[slot]
              if (waveform) setCachedWaveform(existingTrackId, waveform)
            } else {
              // New slot — create a new track
              const result = await sdk.tracks.createTrack({
                userId: user.id,
                metadata: {
                  title: stripExt(file.name),
                  genre: Genre.Electronic,
                  isUnlisted: true,
                  trackCid,
                  origFileCid,
                  duration,
                },
              })
              if (!result.trackId) throw new Error('Track creation failed')
              finalTrackIds[slot] = result.trackId
              // Preseed IDB audio cache for the new track
              setCachedAudio(result.trackId, await file.arrayBuffer())
            }
          }
        }

        // Clear comments on replaced tracks if requested
        if (clearCommentTrackIds?.length) {
          for (const trackId of clearCommentTrackIds) {
            await deleteCommentsForTrack(sdk, user.id, trackId)
            queryClient.invalidateQueries({ queryKey: ['comments', trackId] })
          }
        }

        // Update playlist metadata and contents
        const now = Math.floor(Date.now() / 1000)
        await sdk.playlists.updatePlaylist({
          playlistId: existingPlaylistId,
          userId: user.id,
          metadata: {
            playlistName: name.trim() || 'A/B Test',
            description: descriptionText,
            playlistContents: finalTrackIds.filter(Boolean).map((id) => ({ trackId: id, timestamp: now })),
          },
        })

        // Invalidate playlist cache
        queryClient.invalidateQueries({ queryKey: ['playlistTracks', existingPlaylistId] })

        return existingPlaylistId
      }

      // ── CREATE new project ──
      const uploadedTracks: { trackId: string; file: File; title: string }[] = []

      if (tracks.length > 0) {
        const results = await Promise.all(
          tracks.map((track, i) => {
            const trackKey = track.key
            const updateProgress = (pct: number) => {
              setTracks((prev) =>
                prev.map((t) =>
                  t.key === trackKey ? { ...t, progress: 'uploading' as const, uploadPct: pct } : t
                )
              )
            }

            return uploadFile(sdk, track.file, updateProgress).then(async ({ trackCid, origFileCid, duration }) => {
              const title = track.title || LABELS[i] || `Track ${i + 1}`
              const result = await sdk.tracks.createTrack({
                userId: user.id,
                metadata: {
                  title,
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
              return { trackId: result.trackId, file: track.file, title }
            })
          })
        )
        uploadedTracks.push(...results)
      }

      const trackIds = uploadedTracks.map((t) => t.trackId)
      const now = Math.floor(Date.now() / 1000)
      const playlistName = name.trim() || 'A/B Test'
      const result = await sdk.playlists.createPlaylist({
        userId: user.id,
        metadata: {
          playlistName,
          description: descriptionText,
          isPrivate: true,
          playlistContents: trackIds.map((id) => ({ trackId: id, timestamp: now })),
        },
      })
      if (!result.playlistId) throw new Error('Playlist creation failed')

      // Preseed IDB audio + waveform caches for each track
      for (let i = 0; i < uploadedTracks.length; i++) {
        const { trackId, file } = uploadedTracks[i]
        setCachedAudio(trackId, await file.arrayBuffer())
        const waveform = waveformColorData?.[i]
        if (waveform) setCachedWaveform(trackId, waveform)
      }

      // Preseed react-query playlist cache so page reload is instant
      queryClient.setQueryData(['playlistTracks', result.playlistId], {
        id: result.playlistId,
        playlistName,
        description: descriptionText,
        isAlbum: false,
        isImageAutogenerated: true,
        permalink: '',
        repostCount: 0,
        favoriteCount: 0,
        totalPlayCount: 0,
        user: { id: user.id, handle: user.handle },
        playlistContents: trackIds.map((id) => ({ trackId: id, timestamp: now })),
        tracks: uploadedTracks.map(({ trackId, title }) => ({
          id: trackId,
          title,
          genre: 'Electronic',
          userId: user.id,
          user: { id: user.id, handle: user.handle },
        })),
      })

      return result.playlistId
    },
  })

  return { tracks, addFiles, removeTrack, replaceTrack, mutation }
}
