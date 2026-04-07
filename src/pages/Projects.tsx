import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { getSDK } from '../lib/audius'

const AB_TAG = 'Made with Audius A/B'

function stripTag(desc?: string): string | undefined {
  if (!desc) return undefined
  const stripped = desc.replace(AB_TAG, '').trim()
  return stripped || undefined
}

interface Project {
  id: string
  name: string
  description?: string
  trackCount: number
}

export default function Projects() {
  const [userId, setUserId] = useState<string | null>(null)
  const [handle, setHandle] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const checkAuth = useCallback(async () => {
    const sdk = getSDK()
    try {
      const isAuth = await sdk.oauth.isAuthenticated()
      if (isAuth) {
        const resp = await sdk.users.getMe()
        if (resp.data?.id) {
          setUserId(resp.data.id)
          setHandle(resp.data.handle ?? null)
        }
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { checkAuth() }, [checkAuth])

  const login = useCallback(async () => {
    const sdk = getSDK()
    await sdk.oauth.login({ scope: 'write' })
    const resp = await sdk.users.getMe()
    if (resp.data?.id) {
      setUserId(resp.data.id)
      setHandle(resp.data.handle ?? null)
    }
  }, [])

  useEffect(() => {
    if (!userId) return
    setLoading(true)
    setError(null)
    const sdk = getSDK()
    sdk.users.getPlaylistsByUser({ id: userId, userId })
      .then((resp) => {
        const playlists = resp.data ?? []
        setProjects(
          playlists
            .filter((p) => p.description?.includes(AB_TAG))
            .map((p) => ({
              id: p.id,
              name: p.playlistName,
              description: stripTag(p.description),
              trackCount: p.trackCount,
            }))
        )
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [userId])

  return (
    <div className="page projects-page">
      <div className="page-header creator-header">
        <h1>My Projects</h1>
        {handle && <p className="projects-user">@{handle}</p>}
      </div>

      {!userId ? (
        <div className="projects-login">
          <p>Log in with Audius to see your projects.</p>
          <button type="button" className="btn-primary" onClick={login}>
            Log in
          </button>
        </div>
      ) : loading ? (
        <div className="projects-loading">
          <div className="spinner" />
          <p>Loading projects...</p>
        </div>
      ) : error ? (
        <p className="status-msg error">{error}</p>
      ) : projects.length === 0 ? (
        <div className="projects-empty">
          <p>No projects yet.</p>
          <Link to="/" className="btn-primary">Create one</Link>
        </div>
      ) : (
        <div className="projects-list">
          {projects.map((p) => (
            <div key={p.id} className="project-card">
              <div className="project-card-info">
                <h2>{p.name}</h2>
                {p.description && <p className="project-card-desc">{p.description}</p>}
                <span className="project-card-meta">{p.trackCount} track{p.trackCount !== 1 ? 's' : ''}</span>
              </div>
              <div className="project-card-links">
                <Link to={`/analyze/${p.id}`} className="btn-secondary">Analyze</Link>
                {p.trackCount >= 2 && (
                  <Link to={`/blind/${p.id}`} className="btn-secondary">Blind Test</Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="projects-footer">
        <Link to="/" className="btn-secondary">+ New Project</Link>
      </div>
    </div>
  )
}
