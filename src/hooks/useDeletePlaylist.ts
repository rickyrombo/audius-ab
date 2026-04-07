import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getSDK } from '../lib/audius'
import type { PlaylistWithoutTracks } from '@audius/sdk'

export function useDeletePlaylist(userId: string | null) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (projectId: string) => {
      if (!userId) throw new Error('Not logged in')
      const sdk = getSDK()
      await sdk.playlists.deletePlaylist({ playlistId: projectId, userId })
      return projectId
    },
    onMutate: (projectId) => {
      const prev = queryClient.getQueryData<PlaylistWithoutTracks[]>(['playlists', userId])
      queryClient.setQueryData<PlaylistWithoutTracks[]>(['playlists', userId], (old) =>
        (old ?? []).filter((p) => p.id !== projectId),
      )
      return prev
    },
    onError: (_err, _projectId, prev) => {
      if (prev) {
        queryClient.setQueryData(['playlists', userId], prev)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists', userId] })
    },
  })
}
