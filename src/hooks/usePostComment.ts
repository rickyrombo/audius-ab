import { useMutation, useQueryClient } from '@tanstack/react-query'
import { decodeHashId } from '@audius/sdk'
import { getSDK } from '../lib/audius'
import type { CommentDisplay } from './useComments'

export function usePostComment(
  ensureUser: () => Promise<{ id: string }>,
  currentUserId: string | null,
  currentUserHandle: string | null,
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ trackId, body, timestampS }: { trackId: string; body: string; timestampS: number }) => {
      const sdk = getSDK()
      const user = await ensureUser()
      const numericId = decodeHashId(trackId)
      if (numericId === null) throw new Error('Invalid track ID')
      await sdk.comments.createComment({
        userId: user.id,
        metadata: {
          entityType: 'Track' as const,
          entityId: numericId,
          body,
          trackTimestampS: timestampS,
        },
      })
      return trackId
    },
    onMutate: ({ trackId, body, timestampS }) => {
      const optimistic: CommentDisplay = {
        id: `optimistic-${Date.now()}`,
        userId: currentUserId ?? '',
        handle: currentUserHandle ?? 'you',
        avatarUrl: '',
        avatarMirrors: [],
        body,
        timestampSeconds: timestampS,
      }
      queryClient.setQueryData<CommentDisplay[]>(['comments', trackId], (old) => [optimistic, ...(old ?? [])])
      return { trackId }
    },
    onSettled: (_data, _err, { trackId }) => {
      queryClient.invalidateQueries({ queryKey: ['comments', trackId] })
    },
  })
}
