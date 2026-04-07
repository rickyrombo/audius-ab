import { useQueries } from '@tanstack/react-query'
import { getSDK } from '../lib/audius'

export function useTracks(trackIds: string[], userId?: string | null) {
  return useQueries({
    queries: trackIds.map((id) => ({
      queryKey: ['track', id, userId ?? 'anon'] as const,
      queryFn: async () => {
        const sdk = getSDK()
        const resp = await sdk.tracks.getTrack({ trackId: id, userId: userId ?? undefined })
        return resp.data ?? null
      },
      enabled: !!id,
      staleTime: 60_000,
    })),
  })
}
