declare module "qrcode-terminal" {
  const qrcodeTerminal: {
    generate(input: string, opts: { small?: boolean }, cb?: (output: string) => void): void
    setErrorLevel(error: string): void
  }

  export default qrcodeTerminal
}
