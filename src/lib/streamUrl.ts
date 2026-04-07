import type { UrlWithMirrors } from '@audius/sdk'

/**
 * Get the primary stream URL and mirror fallback URLs from a Track's stream field.
 * Mirrors are host strings — the path from the primary URL is appended to each.
 */
export function getStreamUrls(stream: UrlWithMirrors | undefined): string[] {
  const primary = stream?.url
  if (!primary) return []
  const urls = [primary]
  if (stream?.mirrors?.length) {
    try {
      const path = new URL(primary).pathname
      for (const host of stream.mirrors) {
        urls.push(`${host.replace(/\/$/, '')}${path}`)
      }
    } catch { /* ignore */ }
  }
  return urls
}

/** Get the best single stream URL (primary, or first mirror fallback). */
export function getStreamUrl(stream: UrlWithMirrors | undefined): string {
  return getStreamUrls(stream)[0] ?? ''
}

/** Fetch from the primary URL, falling back to mirrors on failure. */
export async function fetchWithMirrors(urls: string[], timeoutMs = 10_000): Promise<Response> {
  let lastError: Error | null = null
  for (const url of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (resp.ok) return resp
      lastError = new Error(`${resp.status} ${resp.statusText}`)
    } catch (err) {
      clearTimeout(timer)
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new Error('No stream URLs available')
}
