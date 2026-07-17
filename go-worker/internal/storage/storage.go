// Package storage writes chunk summaries to object storage with the
// exact key scheme of src/lib/wealthsim/storage.ts, so the Node app's
// list/aggregate path reads Go-produced objects transparently.
package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"wealthos/go-worker/internal/sim"
)

type Store struct {
	client *s3.Client
	bucket string
}

func New(client *s3.Client, bucket string) *Store {
	return &Store{client: client, bucket: bucket}
}

// ChunkKey mirrors chunkKey in storage.ts: deterministic, so reprocessing
// a redelivered message overwrites the same object.
func ChunkKey(jobID string, chunkIndex int) string {
	return fmt.Sprintf("jobs/%s/chunks/%05d.json", jobID, chunkIndex)
}

func (s *Store) PutChunkSummary(ctx context.Context, summary sim.ChunkSummary) error {
	body, err := json.Marshal(summary)
	if err != nil {
		return fmt.Errorf("marshal chunk summary: %w", err)
	}
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(ChunkKey(summary.JobID, summary.ChunkIndex)),
		Body:        bytes.NewReader(body),
		ContentType: aws.String("application/json"),
	})
	if err != nil {
		return fmt.Errorf("put chunk summary: %w", err)
	}
	return nil
}
