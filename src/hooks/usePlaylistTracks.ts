import { useQuery } from '@tanstack/react-query'
import type { Playlist, Track } from '@audius/sdk'
import { getSDK } from '../lib/audius'

export function usePlaylistTracks(playlistId: string | undefined) {
  return useQuery({
    queryKey: ['playlistTracks', playlistId],
    queryFn: async (): Promise<Playlist> => {
      const sdk = getSDK()
      const resp = await sdk.playlists.getPlaylist({ playlistId: playlistId! })
      const playlist = resp.data?.[0]
      if (!playlist) throw new Error('Playlist not found')

      const trackIds = playlist.playlistContents.map((c) => c.trackId).filter(Boolean)
      if (!trackIds.length) throw new Error('No tracks in playlist')

      const bulkResp = await sdk.tracks.getBulkTracks({ id: trackIds })
      const bulkTracks = bulkResp.data ?? []

      // Preserve playlist order
      playlist.tracks = trackIds
        .map((id) => bulkTracks.find((bt) => bt.id === id))
        .filter((t): t is Track => t != null)

      return playlist
    },
    enabled: !!playlistId,
    staleTime: 60_000,
  })
}
