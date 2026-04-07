import { useMemo } from 'react'
import type { PlaylistWithoutTracks } from '@audius/sdk'
import { usePlaylists } from './usePlaylists'

const AB_TAG = 'Made with Audius A/B'

function stripTag(desc?: string): string | undefined {
  if (!desc) return undefined
  const stripped = desc.replace(AB_TAG, '').trim()
  return stripped || undefined
}

export function useProjects(userId: string | null) {
  const select = useMemo(() => (data: PlaylistWithoutTracks[]) =>
    data
      .filter((p) => p.description?.includes(AB_TAG))
      .map((p) => ({ ...p, description: stripTag(p.description) })),
  [])
  return usePlaylists(userId, select)
}
