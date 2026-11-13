import { onMount } from 'svelte'
import { messageTimestampClock } from './shared-clock'
import { chosenSkyScene, type SkySceneChoice } from './sky-scene'

/**
 * The sky scene to show now, for the component that calls this: the scene the
 * person keeps, or the clock's when their choice is `auto`. Pass the choice as
 * a getter so a change in Settings shows at once.
 * Must be called during component initialisation. It rides the shared minute
 * clock, so it adds no timer, stops while the window is hidden, and is correct
 * again on the first tick after the device wakes.
 */
export function useSkyScene(choice: () => SkySceneChoice) {
  let now = $state(Date.now())
  onMount(() =>
    messageTimestampClock.subscribe((value) => {
      now = value
    }),
  )
  const scene = $derived(chosenSkyScene(choice(), new Date(now)))
  return {
    get current() {
      return scene
    },
  }
}
