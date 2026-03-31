import React from 'react'
import ReactDOM from 'react-dom/client'
import './style.css'

if (window.location.pathname === '/oauth-callback') {
  // Called in OAuth popup; sends postMessage to opener and closes
  import('./lib/audius').then(({ getSDK }) => getSDK().oauth.handleRedirect())
} else {
  import('./App').then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById('app')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  })
}
