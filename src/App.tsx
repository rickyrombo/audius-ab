import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Creator from './pages/Creator'
import Listener from './pages/Listener'
import BlindListener from './pages/BlindListener'

const queryClient = new QueryClient()

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Creator />} />
          <Route path="/analyze/:playlistId" element={<Listener />} />
          <Route path="/blind/:playlistId" element={<BlindListener />} />
          {/* Legacy route */}
          <Route path="/listen/:playlistId" element={<Listener />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
