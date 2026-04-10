import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Navigate } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import Projects from './pages/Projects'
import Listener from './pages/Listener'
import BlindListener from './pages/BlindListener'
import BackgroundVisualizer from './components/BackgroundVisualizer'
import { BackgroundVisualizerProvider } from './contexts/BackgroundVisualizerContext'

const queryClient = new QueryClient()

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BackgroundVisualizerProvider>
        <BackgroundVisualizer />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/create" element={<Navigate to="/analyze" replace />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/analyze" element={<Listener />} />
            <Route path="/analyze/:playlistId" element={<Listener />} />
            <Route path="/blind/:playlistId" element={<BlindListener />} />
            {/* Legacy route */}
            <Route path="/listen/:playlistId" element={<Listener />} />
          </Routes>
        </BrowserRouter>
      </BackgroundVisualizerProvider>
    </QueryClientProvider>
  )
}
