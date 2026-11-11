import themeCss from './theme.css'

// The Tailwind browser runtime compiles every `text/tailwindcss` style it
// finds. This one must exist before the runtime loads, so the module that
// imports the runtime imports this one first.
const style = document.createElement('style')
style.setAttribute('type', 'text/tailwindcss')
style.textContent = themeCss
document.head.appendChild(style)
