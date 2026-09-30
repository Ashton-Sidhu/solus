import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

class ArtifactBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return <p role="alert">The artifact could not render. Reload it or ask for a corrected version.</p>
    }
    return this.props.children
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Artifact mount element is missing.')
createRoot(root).render(<ArtifactBoundary><App /></ArtifactBoundary>)
