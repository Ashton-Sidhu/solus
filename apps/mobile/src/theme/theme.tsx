import { createContext, useContext, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'
import { darkPalette, lightPalette, type Palette } from './tokens'

const ThemeContext = createContext<Palette>(lightPalette)

/** Follows the system appearance; native controls get the same scheme. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme()
  return <ThemeContext.Provider value={scheme === 'dark' ? darkPalette : lightPalette}>{children}</ThemeContext.Provider>
}

export function usePalette(): Palette {
  return useContext(ThemeContext)
}

export function useIsDark(): boolean {
  return useColorScheme() === 'dark'
}
