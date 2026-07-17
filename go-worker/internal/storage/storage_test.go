package storage

import "testing"

// The key scheme must match chunkKey in src/lib/wealthsim/storage.ts
// exactly: the Node aggregation path lists this prefix, and a redelivered
// chunk must overwrite the same object, whichever engine produced it.
func TestChunkKeyMatchesNodeScheme(t *testing.T) {
	cases := []struct {
		jobID string
		index int
		want  string
	}{
		{"job-1", 0, "jobs/job-1/chunks/00000.json"},
		{"job-1", 7, "jobs/job-1/chunks/00007.json"},
		{"abc", 1999, "jobs/abc/chunks/01999.json"},
		{"abc", 123456, "jobs/abc/chunks/123456.json"},
	}
	for _, c := range cases {
		if got := ChunkKey(c.jobID, c.index); got != c.want {
			t.Fatalf("ChunkKey(%q, %d) = %q, want %q", c.jobID, c.index, got, c.want)
		}
	}
}
