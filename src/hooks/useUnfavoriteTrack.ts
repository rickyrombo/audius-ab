import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Track } from '@audius/sdk'
import { getSDK } from '../lib/audius'

export function useUnfavoriteTrack(
  ensureUser: () => Promise<{ id: string }>,
  userId: string | null,
) {
  const queryClient = useQueryClient()
  const userKey = userId ?? 'anon'

  return useMutation({
    mutationFn: async (trackId: string) => {
      const sdk = getSDK()
      const user = await ensureUser()
      await sdk.tracks.unfavoriteTrack({ userId: user.id, trackId })
    },
    onMutate: (trackId) => {
      const prev = queryClient.getQueryData<Track>(['track', trackId, userKey])
      queryClient.setQueryData<Track>(['track', trackId, userKey], (old) => old ? {
        ...old,
        hasCurrentUserSaved: false,
      } : undefined)
      return { trackId, prev }
    },
    onError: (_err, _trackId, context) => {
      if (context?.prev) {
        queryClient.setQueryData(['track', context.trackId, userKey], context.prev)
      }
    },
  })
}
