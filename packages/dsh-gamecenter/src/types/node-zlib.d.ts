declare module 'node:zlib' {
  export function inflateSync(input:Uint8Array,options:{maxOutputLength:number}):Uint8Array
}
