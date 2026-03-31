import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Creator from './pages/Creator'
import Listener from './pages/Listener'

const queryClient = new QueryClient()

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Creator />} />
          <Route path="/listen/:playlistId" element={<Listener />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
