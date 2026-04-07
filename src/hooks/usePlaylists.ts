import { useQuery } from '@tanstack/react-query'
import type { PlaylistWithoutTracks } from '@audius/sdk'
import { getSDK } from '../lib/audius'

export function usePlaylists<T = PlaylistWithoutTracks[]>(
  userId: string | null,
  select?: (data: PlaylistWithoutTracks[]) => T,
) {
  return useQuery({
    queryKey: ['playlists', userId],
    queryFn: async (): Promise<PlaylistWithoutTracks[]> => {
      const sdk = getSDK()
      const resp = await sdk.users.getPlaylistsByUser({ id: userId!, userId: userId! })
      return resp.data ?? []
    },
    enabled: !!userId,
    staleTime: 30_000,
    select,
  })
}
