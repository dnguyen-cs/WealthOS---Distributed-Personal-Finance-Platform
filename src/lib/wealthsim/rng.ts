// Deterministic random number generation for the simulation kernel.
// Everything here is pure 32-bit integer math, so a chunk spec (seed +
// params) always reproduces the same output on the same JS engine. That
// determinism is what makes reprocessing a redelivered queue message
// idempotent: the rewritten result is byte-identical.

// splitmix32: expands one uint32 seed into a stream of well-mixed uint32s.
// Used to seed sfc32 state and to derive independent per-chunk seeds.
export function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

// Independent seed for chunk i of a job, spread so adjacent chunk indexes
// do not produce correlated streams.
export function deriveChunkSeed(jobSeed: number, chunkIndex: number): number {
  const mixed = (jobSeed ^ Math.imul(chunkIndex + 1, 0x85ebca6b)) >>> 0;
  return splitmix32(mixed)();
}

// sfc32 ("Small Fast Counter"): fast, high-quality 128-bit-state PRNG.
export class RandomSource {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spare: number | null = null;

  constructor(seed: number) {
    const mix = splitmix32(seed);
    this.a = mix();
    this.b = mix();
    this.c = mix();
    this.d = mix();
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  nextUint32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (((this.c << 21) | (this.c >>> 11)) + t) >>> 0;
    return t;
  }

  // Uniform in [0, 1) with 32-bit resolution.
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }

  // Standard normal via Marsaglia's polar method; the second value of each
  // generated pair is cached, so cost averages one pair per two calls.
  nextNormal(): number {
    if (this.spare !== null) {
      const value = this.spare;
      this.spare = null;
      return value;
    }
    let u: number;
    let v: number;
    let s: number;
    do {
      u = 2 * this.nextFloat() - 1;
      v = 2 * this.nextFloat() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * m;
    return u * m;
  }
}
