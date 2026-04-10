import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { getSDK } from '../lib/audius'
import { useProjects } from '../hooks/useProjects'
import { useDeletePlaylist } from '../hooks/useDeletePlaylist'

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn-copy"
      onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

export default function Projects() {
  const [userId, setUserId] = useState<string | null>(null)
  const [handle, setHandle] = useState<string | null>(null)

  const { data: projects = [], isLoading, error: queryError } = useProjects(userId)
  const deleteMutation = useDeletePlaylist(userId)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

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

  const error = queryError?.message ?? (deleteMutation.isError ? deleteMutation.error.message : null)

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
      ) : isLoading ? (
        <div className="projects-loading">
          <div className="spinner" />
          <p>Loading projects...</p>
        </div>
      ) : error ? (
        <p className="status-msg error">{error}</p>
      ) : projects.length === 0 ? (
        <div className="projects-empty">
          <p>No projects yet.</p>
          <Link to="/analyze" className="btn-primary">Create one</Link>
        </div>
      ) : (
        <div className="projects-list">
          {projects.map((p) => {
            const analyzeUrl = `${window.location.origin}/analyze/${p.id}`
            const blindUrl = `${window.location.origin}/blind/${p.id}`
            return (
              <div key={p.id} className="project-card">
                <div className="project-card-info">
                  <h2>{p.playlistName}</h2>
                  {p.description && <p className="project-card-desc">{p.description}</p>}
                  <span className="project-card-meta">{p.trackCount} track{p.trackCount !== 1 ? 's' : ''}</span>
                </div>
                <button
                  type="button"
                  className="btn-delete"
                  onClick={() => setDeleteConfirm(p.id)}
                  title="Delete project"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
                <div className="project-card-share">
                  <div className="result-link-group">
                    <label>Analysis</label>
                    <div className="result-url">
                      <input type="text" readOnly value={analyzeUrl} />
                      <CopyButton url={analyzeUrl} />
                      <Link to={`/analyze/${p.id}`} className="btn-secondary">View</Link>
                    </div>
                  </div>
                  {p.trackCount >= 2 && (
                    <div className="result-link-group">
                      <label>Blind Test</label>
                      <div className="result-url">
                        <input type="text" readOnly value={blindUrl} />
                        <CopyButton url={blindUrl} />
                        <Link to={`/blind/${p.id}`} className="btn-secondary">View</Link>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="projects-footer">
        <Link to="/analyze" className="btn-secondary">+ New Project</Link>
      </div>

      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <p>Delete this project?</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary btn-danger"
                onClick={() => {
                  deleteMutation.mutate(deleteConfirm)
                  setDeleteConfirm(null)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
