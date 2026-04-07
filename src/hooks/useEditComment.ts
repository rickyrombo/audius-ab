import { useMutation, useQueryClient } from '@tanstack/react-query'
import { decodeHashId } from '@audius/sdk'
import { getSDK } from '../lib/audius'
import type { CommentDisplay } from './useComments'

export function useEditComment(
  ensureUser: () => Promise<{ id: string }>,
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ commentId, trackId, body }: { commentId: string; trackId: string; body: string }) => {
      const sdk = getSDK()
      const user = await ensureUser()
      const numericId = decodeHashId(trackId)
      if (numericId === null) throw new Error('Invalid track ID')
      await sdk.comments.updateComment({
        commentId,
        userId: user.id,
        metadata: {
          entityType: 'Track' as const,
          entityId: numericId,
          body,
        },
      })
      return { commentId, trackId, body }
    },
    onMutate: ({ commentId, trackId, body }) => {
      const prev = queryClient.getQueryData<CommentDisplay[]>(['comments', trackId])
      queryClient.setQueryData<CommentDisplay[]>(['comments', trackId], (old) =>
        (old ?? []).map((c) => c.id === commentId ? { ...c, body } : c),
      )
      return { trackId, prev }
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(['comments', context.trackId], context.prev)
      }
    },
    onSettled: (_data, _err, { trackId }) => {
      queryClient.invalidateQueries({ queryKey: ['comments', trackId] })
    },
  })
}
