import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Track } from '@audius/sdk'
import { getSDK } from '../lib/audius'

export function useFavoriteTrack(
  trackIds: string[],
  ensureUser: () => Promise<{ id: string }>,
  userId: string | null,
) {
  const queryClient = useQueryClient()
  const userKey = userId ?? 'anon'

  return useMutation({
    mutationFn: async (trackId: string) => {
      const sdk = getSDK()
      const user = await ensureUser()
      await sdk.tracks.favoriteTrack({ userId: user.id, trackId })
    },
    onMutate: (trackId) => {
      const snapshots = trackIds.map((id) => [id, queryClient.getQueryData<Track>(['track', id, userKey])] as const)
      for (const id of trackIds) {
        queryClient.setQueryData<Track>(['track', id, userKey], (old) => old ? {
          ...old,
          hasCurrentUserSaved: id === trackId,
        } : undefined)
      }
      return { snapshots }
    },
    onError: (_err, _trackId, context) => {
      if (context?.snapshots) {
        for (const [id, data] of context.snapshots) {
          queryClient.setQueryData(['track', id, userKey], data)
        }
      }
    },
  })
}
