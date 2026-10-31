/** Setup guidance shared by the desktop, web, and mobile device source forms. */
export const EAS_SETUP_HELP = {
  commands: 'npx eas-cli@latest login\nnpx eas-cli@latest init\nnpx eas-cli@latest project:info\nnpx eas-cli@latest simulator:availability --json',
  location: 'Run these commands in your Expo app folder on the Solus host. For a remote host, use a terminal on that machine.',
  project: 'Select your existing project when linking. Copy the project ID from project:info into Expo project ID below. If the host is signed in, leave the token blank and use Check connection to choose a project.',
  token: 'If you cannot sign in on the host, create an Expo access token and paste it below. The token must have access to the project.',
  access: 'Expo Simulators is a limited-access preview. Your project’s account must have access; creating an Expo project alone does not enable it.',
  links: [
    { label: 'Expo Simulator setup guide', url: 'https://docs.expo.dev/agentic-workflows/setup/' },
    { label: 'Create an Expo access token', url: 'https://expo.dev/settings/access-tokens' },
  ],
} as const
