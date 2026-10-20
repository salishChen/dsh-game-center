declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array, inputEncoding?: 'utf-8' | 'utf8'): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: 'sha256'): Hash
  export function randomBytes(size: number): {
    toString(encoding: 'hex' | 'base64' | 'base64url'): string
  }
}

declare module 'node:path' {
  export function join(...paths: string[]): string
  export function dirname(p: string): string
  export function basename(p: string, ext?: string): string
  export function resolve(...paths: string[]): string
  export function relative(from: string, to: string): string
}

declare module 'node:fs' {
  export interface Stats {
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
    size: number
  }

  export namespace promises {
    export function readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
    export function readFile(path: string): Promise<Buffer>
    export function writeFile(
      path: string,
      data: string | Uint8Array | Buffer,
      encoding?: 'utf-8' | 'utf8',
    ): Promise<void>
    export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
    export function rename(oldPath: string, newPath: string): Promise<void>
    export function stat(path: string): Promise<Stats>
    export function lstat(path: string): Promise<Stats>
    export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
    export function readdir(path: string): Promise<string[]>
  }
}

interface Buffer extends Uint8Array {
  toString(encoding?: string): string
  length: number
}

declare var Buffer: {
  from(data: string | Uint8Array | ArrayBuffer, encoding?: string): Buffer
  byteLength(string: string, encoding?: string): number
}
