import { useQueries } from '@tanstack/react-query'
import { getSDK } from '../lib/audius'

export interface CommentDisplay {
  id: string
  userId: string
  handle: string
  avatarUrl: string
  avatarMirrors: string[]
  body: string
  timestampSeconds: number
}

export function useComments(
  trackIds: string[],
  ownerId: string | null,
  currentUserId: string | null,
) {
  const queries = useQueries({
    queries: trackIds.map((id) => ({
      queryKey: ['comments', id],
      queryFn: async (): Promise<CommentDisplay[]> => {
        const sdk = getSDK()
        const resp = await sdk.tracks.getTrackComments({ trackId: id })
        const items = resp.data ?? []
        const users = resp.related?.users ?? []
        const userMap = new Map(users.map((u) => [u.id, u]))
        return items.map((c) => {
          const user = c.userId ? userMap.get(c.userId) : null
          const pic = user?.profilePicture
          let primaryUrl = ''
          let mirrorUrls: string[] = []
          if (pic) {
            primaryUrl = pic._150x150 ?? pic._480x480 ?? pic._1000x1000 ?? ''
            if (primaryUrl && pic.mirrors) {
              try {
                const path = new URL(primaryUrl).pathname
                mirrorUrls = pic.mirrors.map((host) => `${host.replace(/\/$/, '')}${path}`)
              } catch { /* ignore */ }
            }
          }
          return {
            id: c.id,
            userId: c.userId ?? '',
            handle: user?.handle ?? c.userId ?? 'anon',
            avatarUrl: primaryUrl,
            avatarMirrors: mirrorUrls,
            body: c.message,
            timestampSeconds: c.trackTimestampS ?? 0,
          }
        })
      },
      enabled: !!id,
      staleTime: 30_000,
    })),
  })

  return queries.map((q) => {
    const comments = q.data ?? []
    if (!ownerId && !currentUserId) return comments
    return comments.filter((c) =>
      (ownerId && c.userId === ownerId) || (currentUserId && c.userId === currentUserId)
    )
  })
}
