declare module '*.mp3' {
  const src: string
  export default src
}

declare module '*?worker' {
  const workerConstructor: { new (): Worker }
  export default workerConstructor
}
