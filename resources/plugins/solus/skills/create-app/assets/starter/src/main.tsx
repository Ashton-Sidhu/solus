import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

class AppBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return <p role="alert" className="p-6 text-sm">The app could not render. Reload it, or read its calls on the Manage page.</p>
    }
    return this.props.children
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('The app mount element is missing.')
createRoot(root).render(<AppBoundary><App /></AppBoundary>)
