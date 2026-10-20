declare module 'node:path' {
  export function join(...paths: string[]): string
  export function dirname(p: string): string
  export function basename(p: string, ext?: string): string
  export function resolve(...paths: string[]): string
  export function relative(from: string, to: string): string
  export function isAbsolute(p: string): boolean
}

declare module 'node:fs' {
  export interface Stats {
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
    size: number
  }

  export interface Dirent {
    name: string
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
  }

  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
  export function writeFileSync(path: string, data: string, encoding?: string): void
  export function readFileSync(path: string, encoding?: string): string

  export namespace promises {
    export function readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
    export function readFile(path: string): Promise<Buffer>
    export function stat(path: string): Promise<Stats>
    export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
    export function readdir(path: string): Promise<string[]>
  }
}

declare module 'node:os' {
  export function tmpdir(): string
  export function homedir(): string
}
