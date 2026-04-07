import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getSDK } from '../lib/audius'
import type { CommentDisplay } from './useComments'

export function useDeleteComment(
  ensureUser: () => Promise<{ id: string }>,
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ commentId, trackId }: { commentId: string; trackId: string }) => {
      const sdk = getSDK()
      const user = await ensureUser()
      await sdk.comments.deleteComment({ commentId, userId: user.id })
      return { commentId, trackId }
    },
    onMutate: ({ commentId, trackId }) => {
      const prev = queryClient.getQueryData<CommentDisplay[]>(['comments', trackId])
      queryClient.setQueryData<CommentDisplay[]>(['comments', trackId], (old) =>
        (old ?? []).filter((c) => c.id !== commentId),
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
