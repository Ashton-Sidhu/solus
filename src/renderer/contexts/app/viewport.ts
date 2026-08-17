// Layout: which shell to render (mobile vs desktop)
export const MOBILE_QUERY = '(max-width: 767px)'

// Layout: laptop-scale viewport. This is based on the app window's logical CSS
// width, not the display's physical Retina pixels. It includes the 15" MacBook
// Pro's 1512 × 982 display mode and the 16" 1728px mode.
export const LAPTOP_VIEWPORT_MAX_WIDTH = 1800
export const LAPTOP_QUERY = `(max-width: ${LAPTOP_VIEWPORT_MAX_WIDTH}px)`

