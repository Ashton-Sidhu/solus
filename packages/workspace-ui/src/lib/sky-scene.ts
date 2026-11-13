/**
 * The sky art follows the clock of this device: four scenes, each a static
 * picture (docs/plans/sidebar-places-and-sky.md). The hours are fixed clock
 * hours, not the sunrise and sunset of a place, so no location is read.
 */
export const SKY_SCENES = ['dawn', 'day', 'dusk', 'night'] as const
export type SkyScene = (typeof SKY_SCENES)[number]

/** What a person chose in Settings: follow the clock, or keep one scene. */
export const SKY_SCENE_CHOICES = ['auto', ...SKY_SCENES] as const
export type SkySceneChoice = (typeof SKY_SCENE_CHOICES)[number]

const SCENE_STARTS: readonly { scene: SkyScene; hour: number }[] = [
  { scene: 'dawn', hour: 5 },
  { scene: 'day', hour: 9 },
  { scene: 'dusk', hour: 17 },
  { scene: 'night', hour: 21 },
]

/** The last scene that has started. Night runs past midnight, until dawn. */
export function skySceneAt(time: Date): SkyScene {
  const hour = time.getHours()
  let current: SkyScene = 'night'
  for (const start of SCENE_STARTS) {
    if (start.hour <= hour) current = start.scene
  }
  return current
}

/** The scene to show: the one a person keeps, or the clock's when they follow it. */
export function chosenSkyScene(choice: SkySceneChoice, time: Date): SkyScene {
  return choice === 'auto' ? skySceneAt(time) : choice
}

/** Dusk and night stay dark in the light theme too, so the controls that sit
 *  on them must read light in both themes. */
export function isDarkSkyScene(scene: SkyScene): boolean {
  return scene === 'dusk' || scene === 'night'
}
