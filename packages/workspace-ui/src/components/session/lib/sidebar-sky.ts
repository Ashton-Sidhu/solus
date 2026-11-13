/**
 * The fixed geometry of the sidebar's sky art: the orbit lines that dawn and
 * day draw around the mark, and the stars of dusk and night. Computed once at
 * load, so the art is static markup.
 */

// The three arcs of the Solus mark as fractions of a full turn, each followed
// by its gap (resources/tray-master.svg).
const MARK_ARC_TURNS = [90, 39, 69.4, 32.6, 56.7, 72.3].map((degrees) => degrees / 360)
const ORBIT_RADII = [17, 27, 39, 53, 69, 87, 107, 129]

export interface SkyOrbit {
  radius: number
  dashArray: string
  /** Degrees. Each orbit turns a little more than the one inside it. */
  rotation: number
  opacity: number
}

/** The largest orbit, which sets how far the line art reaches from the mark. */
export const SKY_ORBIT_REACH = ORBIT_RADII[ORBIT_RADII.length - 1] + 8

export const SKY_ORBITS: readonly SkyOrbit[] = ORBIT_RADII.map((radius, index) => {
  const circumference = 2 * Math.PI * radius
  return {
    radius,
    dashArray: MARK_ARC_TURNS.map((turn) => (turn * circumference).toFixed(2)).join(' '),
    rotation: -90 + index * 23,
    opacity: 0.42 - index * 0.035,
  }
})

/**
 * Room under the title bar row that the sky keeps for itself, in rem. The
 * sidebar's content starts this much lower and the sky's bar is this much
 * taller, so the header reads as a band and not as a tinted title bar.
 */
export const SKY_HEADER_DROP_REM = 1.5

export interface SkyStar {
  /** Percent of the band, so the field spreads with the sidebar's width. */
  x: number
  y: number
  radius: number
  opacity: number
  /** Most stars are white; a few are warm or cool, as real stars are. */
  color: string
  /** The brightest stars carry a soft halo. */
  isBright: boolean
}

/** The same seed gives the same stars, so the field never moves between renders. */
function starField(count: number, seed: number): SkyStar[] {
  let state = seed
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
  return Array.from({ length: count }, () => {
    const x = Math.round(next() * 1000) / 10
    const y = Math.round(next() * 1000) / 10
    // Cubed, so most stars are faint pin points and only a few are large.
    const radius = Math.round((0.35 + next() ** 3 * 0.95) * 100) / 100
    const opacity = Math.round((0.3 + next() * 0.65) * 100) / 100
    const hue = next()
    return {
      x,
      y,
      radius,
      opacity,
      color: hue < 0.12 ? '#ffe6c2' : hue < 0.3 ? '#cfdaff' : '#ffffff',
      isBright: radius > 0.95,
    }
  })
}

export const SKY_STARS: readonly SkyStar[] = starField(64, 7)
