/** Mount the roleplay application after the profile supplies its public bootstrap data. */
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('The roleplay application mount is missing.')
createRoot(root).render(<App />)
