import { useMutation, useQueryClient } from '@tanstack/react-query'
import { decodeHashId } from '@audius/sdk'
import { getSDK } from '../lib/audius'

interface TrackInfo {
  id: string
  title: string
}

interface CommentDisplay {
  id: string
  userId: string
  handle: string
  avatarUrl: string
  avatarMirrors: string[]
  body: string
  timestampSeconds: number
}

export function useBlindSubmit(
  ensureUser: () => Promise<{ id: string }>,
  currentUserHandle: string | null,
  callbacks: {
    onSubmit: () => void
    onError: () => void
  },
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ chosenTrack, reason }: { chosenTrack: TrackInfo; reason: string }) => {
      const sdk = getSDK()
      const user = await ensureUser()
      await sdk.tracks.favoriteTrack({ userId: user.id, trackId: chosenTrack.id })
      if (reason) {
        const numericId = decodeHashId(chosenTrack.id)
        if (numericId !== null) {
          await sdk.comments.createComment({
            userId: user.id,
            metadata: {
              entityType: 'Track' as const,
              entityId: numericId,
              body: `My blind vote: ${reason}`,
              trackTimestampS: 0,
            },
          })
        }
      }
    },
    onMutate: ({ chosenTrack, reason }) => {
      callbacks.onSubmit()
      if (reason && currentUserHandle) {
        const prev = queryClient.getQueryData(['comments', chosenTrack.id])
        const optimisticComment: CommentDisplay = {
          id: `optimistic-${Date.now()}`,
          userId: '',
          handle: currentUserHandle,
          avatarUrl: '',
          avatarMirrors: [],
          body: `My blind vote: ${reason}`,
          timestampSeconds: 0,
        }
        queryClient.setQueryData(['comments', chosenTrack.id], (old: unknown[]) => [
          optimisticComment,
          ...(old ?? []),
        ])
        return { prev, trackId: chosenTrack.id }
      }
    },
    onError: (_err, _vars, context) => {
      if (context?.prev !== undefined) {
        queryClient.setQueryData(['comments', context.trackId], context.prev)
      }
      callbacks.onError()
    },
    onSettled: (_data, _err, { chosenTrack }) => {
      queryClient.invalidateQueries({ queryKey: ['comments', chosenTrack.id] })
    },
  })
}
