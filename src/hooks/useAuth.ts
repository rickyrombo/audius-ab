import { useState, useCallback } from 'react'
import { getSDK } from '../lib/audius'

export function useAuth() {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [currentUserHandle, setCurrentUserHandle] = useState<string | null>(null)

  const checkAuth = useCallback(async () => {
    const sdk = getSDK()
    try {
      const isAuth = await sdk.oauth.isAuthenticated()
      if (isAuth) {
        const resp = await sdk.users.getMe()
        const user = resp.data
        if (user?.id) setCurrentUserId(user.id)
        if (user?.handle) setCurrentUserHandle(user.handle)
      }
    } catch { /* ignore */ }
  }, [])

  const ensureUser = useCallback(async () => {
    const sdk = getSDK()
    const isAuth = await sdk.oauth.isAuthenticated()
    if (!isAuth) await sdk.oauth.login({ scope: 'write' })
    const resp = await sdk.users.getMe()
    const user = resp.data
    if (!user) throw new Error('Failed to get user')
    if (user.id) setCurrentUserId(user.id)
    if (user.handle) setCurrentUserHandle(user.handle)
    return user
  }, [])

  const logout = useCallback(async () => {
    const sdk = getSDK()
    await sdk.oauth.logout()
    setCurrentUserId(null)
    setCurrentUserHandle(null)
  }, [])

  return { currentUserId, currentUserHandle, checkAuth, ensureUser, logout }
}
