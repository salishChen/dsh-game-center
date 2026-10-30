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
  export function existsSync(path: string): boolean
  export function statSync(path: string): Stats

  export namespace promises {
    export function readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
    export function readFile(path: string): Promise<Buffer>
    export function stat(path: string): Promise<Stats>
    export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
    export function readdir(path: string): Promise<string[]>
    export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  }
}

declare module 'node:os' {
  export function tmpdir(): string
  export function homedir(): string
}

declare class Buffer extends Uint8Array {
  static from(arrayBuffer: ArrayBuffer | ArrayBufferLike): Buffer
  static from(str: string, encoding?: string): Buffer
  static concat(list: readonly Uint8Array[]): Buffer
  toString(encoding?: string): string
  readUInt16BE(offset: number): number
  readUInt16LE(offset: number): number
  readUInt32BE(offset: number): number
  readonly length: number
}

declare module 'node:buffer' {
  export class Buffer extends Uint8Array {
    static from(arrayBuffer: ArrayBuffer | ArrayBufferLike): Buffer
    static from(str: string, encoding?: string): Buffer
    static concat(list: readonly Uint8Array[]): Buffer
    toString(encoding?: string): string
    readUInt16BE(offset: number): number
    readUInt16LE(offset: number): number
    readUInt32BE(offset: number): number
    readonly length: number
  }
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

declare module 'node:dns/promises' {
  export function lookup(hostname: string): Promise<{ address: string; family: number }>
}

declare interface ReadableStreamDefaultReader<T = any> {
  read(): Promise<{ done: boolean; value?: T }>
  cancel(reason?: any): Promise<void>
}

declare interface ReadableStream<T = any> {
  getReader(): ReadableStreamDefaultReader<T>
}

declare namespace NodeJS {
  interface Process {
    argv: string[]
    env: Record<string, string | undefined>
  }
}

declare var process: NodeJS.Process
