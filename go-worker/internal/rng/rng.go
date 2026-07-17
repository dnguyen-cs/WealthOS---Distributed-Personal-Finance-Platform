// Package rng is a bit-faithful port of src/lib/wealthsim/rng.ts.
//
// Everything in the TypeScript original is pure 32-bit integer math
// (Math.imul, >>>, <<, ^), which maps 1:1 onto Go's uint32 arithmetic:
// JavaScript's int32/uint32 coercions and Go's wrapping uint32 ops agree
// modulo 2^32 on every operation used here. That makes the two engines'
// raw random streams bit-identical by construction, which the parity
// test suite asserts against vectors generated from the Node kernel.
package rng

import (
	"math"
	"math/bits"
)

// Splitmix32 expands one uint32 seed into a stream of well-mixed uint32s.
// Mirrors splitmix32 in rng.ts.
func Splitmix32(seed uint32) func() uint32 {
	a := seed
	return func() uint32 {
		a += 0x9e3779b9
		t := a
		t = (t ^ (t >> 16)) * 0x21f0aaad
		t = (t ^ (t >> 15)) * 0x735a2d97
		return t ^ (t >> 15)
	}
}

// DeriveChunkSeed mirrors deriveChunkSeed in rng.ts: an independent seed
// for chunk i of a job, spread so adjacent chunk indexes do not produce
// correlated streams.
func DeriveChunkSeed(jobSeed uint32, chunkIndex int) uint32 {
	mixed := jobSeed ^ (uint32(chunkIndex+1) * 0x85ebca6b)
	return Splitmix32(mixed)()
}

// RandomSource mirrors the sfc32-based RandomSource class in rng.ts.
type RandomSource struct {
	a, b, c, d uint32
	spare      float64
	hasSpare   bool
}

func NewRandomSource(seed uint32) *RandomSource {
	mix := Splitmix32(seed)
	r := &RandomSource{a: mix(), b: mix(), c: mix(), d: mix()}
	for i := 0; i < 12; i++ {
		r.NextUint32()
	}
	return r
}

func (r *RandomSource) NextUint32() uint32 {
	t := r.a + r.b + r.d
	r.d++
	r.a = r.b ^ (r.b >> 9)
	r.b = r.c + (r.c << 3)
	r.c = bits.RotateLeft32(r.c, 21) + t
	return t
}

// NextFloat is uniform in [0, 1) with 32-bit resolution. uint32-to-float64
// conversion and division by 2^32 are both exact in IEEE 754, so this is
// bit-identical to the Node kernel's nextFloat.
func (r *RandomSource) NextFloat() float64 {
	return float64(r.NextUint32()) / 4294967296.0
}

// NextNormal is a standard normal via Marsaglia's polar method with the
// same spare-caching as the Node kernel. u, v, and s are built from exact
// IEEE operations, so the rejection decisions are bit-identical across
// engines; the output can differ from Node in the last ulp only through
// math.Log (exp/log are not required to be correctly rounded, sqrt is).
func (r *RandomSource) NextNormal() float64 {
	if r.hasSpare {
		r.hasSpare = false
		return r.spare
	}
	var u, v, s float64
	for {
		u = 2*r.NextFloat() - 1
		v = 2*r.NextFloat() - 1
		s = u*u + v*v
		if !(s >= 1 || s == 0) {
			break
		}
	}
	m := math.Sqrt(-2 * math.Log(s) / s)
	r.spare = v * m
	r.hasSpare = true
	return u * m
}
