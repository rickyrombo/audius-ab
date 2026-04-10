import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useProjects } from '../hooks/useProjects'
import { useDeletePlaylist } from '../hooks/useDeletePlaylist'
import { useAuth } from '../hooks/useAuth'
import { CopyButton } from '../components/CopyButton'

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export default function Projects() {
  const { currentUserId, currentUserHandle, checkAuth, ensureUser } = useAuth()

  const { data: projects = [], isLoading, error: queryError } = useProjects(currentUserId)
  const deleteMutation = useDeletePlaylist(currentUserId)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)

  useEffect(() => { checkAuth() }, [checkAuth])

  useEffect(() => {
    document.title = "My Projects — A/B"
    return () => { document.title = "A/B — Compare Audio Mixes Side by Side" }
  }, [])

  const login = async () => {
    setLoginError(null)
    try {
      await ensureUser()
    } catch {
      setLoginError('Login failed. Please try again.')
    }
  }

  const error = queryError?.message ?? (deleteMutation.isError ? deleteMutation.error.message : null)
  const deleteTarget = projects.find((p) => p.id === deleteConfirm)

  return (
    <div className="page projects-page">
      <div className="projects-header">
        <Link to="/" className="header-logo" title="Home">
          <svg viewBox="0 0 159.67 56.8926" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M137.958 0.138672C152.432 0.138704 159.67 4.86494 159.67 14.3164C159.67 23.7677 153.071 28.4931 139.875 28.4932C153.071 28.4932 159.67 33.2339 159.67 42.7148C159.67 51.8097 152.432 56.5359 137.958 56.8926H76.1719L95.5156 21.5039V22.0293H128.061C133.113 21.9699 135.64 20.3197 135.64 17.0801C135.64 13.8405 133.113 12.1913 128.061 12.1318H100.639L107.194 0.138672H137.958ZM66.8525 56.8379H47.3359L78.75 0H98.0957L66.8525 56.8379ZM68.0205 5.61133L55.7354 28.0869L48.1045 14.7119L36.6914 35.2646H51.8125L45.6221 46.5889H30.4053L24.7881 56.7539H0L30.8066 0H64.957L68.0205 5.61133ZM95.5156 43.7402H128.061C133.113 43.6808 135.64 42.0316 135.64 38.792C135.64 35.5523 133.113 33.9032 128.061 33.8438H95.5156V43.7402Z"/>
          </svg>
        </Link>
        <div>
          <h1>My Projects</h1>
          {currentUserHandle && <p className="projects-user">@{currentUserHandle}</p>}
        </div>
        <div className="projects-header-actions">
          <Link to="/analyze" className="btn-header btn-header-text" title="Create new project">
            + New Project
          </Link>
        </div>
      </div>

      {!currentUserId ? (
        <div className="projects-login">
          <p>Log in with Audius to see your projects.</p>
          <button type="button" className="btn-primary" onClick={login}>
            Log in
          </button>
          {loginError && <p className="status-msg error">{loginError}</p>}
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
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <p>No projects yet</p>
          <Link to="/analyze" className="btn-primary">Create your first project</Link>
        </div>
      ) : (
        <div className="projects-list">
          {projects.map((p) => {
            const analyzeUrl = `${window.location.origin}/analyze/${p.id}`
            const blindUrl = `${window.location.origin}/blind/${p.id}`
            const isExpanded = expandedId === p.id
            const isDeleting = deleteMutation.isPending && deleteMutation.variables === p.id
            return (
              <div key={p.id} className={`project-card${isDeleting ? ' project-card-deleting' : ''}`}>
                <Link to={`/analyze/${p.id}`} className="project-card-info">
                  <h2>{p.playlistName}</h2>
                  {p.description && <p className="project-card-desc">{p.description}</p>}
                  <div className="project-card-meta">
                    <span>{p.trackCount} track{p.trackCount !== 1 ? 's' : ''}</span>
                    <span className="project-card-dot">&middot;</span>
                    <span>{timeAgo(p.updatedAt)}</span>
                  </div>
                </Link>
                <div className="project-card-actions">
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => setExpandedId(isExpanded ? null : p.id)}
                    title="Share links"
                    aria-label="Share links"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                      <polyline points="16 6 12 2 8 6" />
                      <line x1="12" y1="2" x2="12" y2="15" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="btn-icon btn-icon-danger"
                    onClick={() => setDeleteConfirm(p.id)}
                    title="Delete project"
                    aria-label="Delete project"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                  </button>
                </div>
                {isExpanded && (
                  <div className="project-card-share">
                    <div className="result-link-group">
                      <label>Analysis</label>
                      <div className="result-url">
                        <input type="text" readOnly value={analyzeUrl} />
                        <CopyButton url={analyzeUrl} />
                      </div>
                    </div>
                    {p.trackCount >= 2 && (
                      <div className="result-link-group">
                        <label>Blind Test</label>
                        <div className="result-url">
                          <input type="text" readOnly value={blindUrl} />
                          <CopyButton url={blindUrl} />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete Project</h3>
            <p>Are you sure you want to delete <strong>{deleteTarget?.playlistName ?? 'this project'}</strong>? This cannot be undone.</p>
            {deleteMutation.isError && (
              <p className="status-msg error">{deleteMutation.error.message}</p>
            )}
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
                disabled={deleteMutation.isPending}
                onClick={() => {
                  deleteMutation.mutate(deleteConfirm, {
                    onSuccess: () => setDeleteConfirm(null),
                  })
                }}
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
