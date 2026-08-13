/** Incremental SHA-256 for browser Blobs. Reads bounded slices; never buffers the whole file. */
export async function sha256Blob(blob: Blob, options: { chunkBytes?: number; signal?: AbortSignal; onProgress?: (hashedBytes: number, totalBytes: number) => void } = {}): Promise<string> {
  const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 64 * 1024 || chunkBytes > 64 * 1024 * 1024) throw new RangeError('checksum chunkBytes must be 65536..67108864');
  const hash = new Sha256();
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('checksum aborted');
    const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkBytes)).arrayBuffer());
    hash.update(bytes);
    options.onProgress?.(Math.min(blob.size, offset + bytes.byteLength), blob.size);
  }
  return hash.digestHex();
}

const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
class Sha256 {
  private h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private buffer = new Uint8Array(64); private buffered = 0; private bytes = 0; private done = false;
  update(input: Uint8Array): void { if(this.done)throw new Error('checksum already finalized');this.bytes+=input.length;let offset=0;if(this.buffered){const take=Math.min(64-this.buffered,input.length);this.buffer.set(input.subarray(0,take),this.buffered);this.buffered+=take;offset+=take;if(this.buffered===64){this.block(this.buffer);this.buffered=0;}}while(offset+64<=input.length){this.block(input.subarray(offset,offset+64));offset+=64;}if(offset<input.length){this.buffer.set(input.subarray(offset),0);this.buffered=input.length-offset;} }
  digestHex(): string { if(this.done)throw new Error('checksum already finalized');this.done=true;const bitHigh=Math.floor(this.bytes/0x20000000),bitLow=(this.bytes<<3)>>>0;this.buffer[this.buffered++]=0x80;if(this.buffered>56){this.buffer.fill(0,this.buffered);this.block(this.buffer);this.buffered=0;}this.buffer.fill(0,this.buffered,56);const view=new DataView(this.buffer.buffer);view.setUint32(56,bitHigh);view.setUint32(60,bitLow);this.block(this.buffer);return [...this.h].map(v=>v.toString(16).padStart(8,'0')).join(''); }
  private block(bytes:Uint8Array):void{const w=new Uint32Array(64),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let i=0;i<16;i++)w[i]=view.getUint32(i*4);for(let i=16;i<64;i++){const a=w[i-15]!,b=w[i-2]!;w[i]=(w[i-16]!+((ror(a,7)^ror(a,18)^(a>>>3)))+w[i-7]!+(ror(b,17)^ror(b,19)^(b>>>10)))>>>0;}let[a,b,c,d,e,f,g,h]=this.h;for(let i=0;i<64;i++){const t1=(h!+(ror(e!,6)^ror(e!,11)^ror(e!,25))+((e!&f!)^(~e!&g!))+K[i]!+w[i]!)>>>0,t2=((ror(a!,2)^ror(a!,13)^ror(a!,22))+((a!&b!)^(a!&c!)^(b!&c!)))>>>0;h=g;g=f;f=e;e=(d!+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}const values=[a,b,c,d,e,f,g,h];for(let i=0;i<8;i++)this.h[i]=(this.h[i]!+values[i]!)>>>0;}
}
function ror(value:number,bits:number):number{return(value>>>bits)|(value<<(32-bits));}
