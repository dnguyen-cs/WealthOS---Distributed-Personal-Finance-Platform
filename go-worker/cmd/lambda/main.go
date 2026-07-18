// WealthSim chunk consumer, Lambda edition: the scale-to-zero demo lane.
// Same kernel and storage contract as cmd/worker (AWS Batch stays the
// benchmark lane); polling, retry, and scaling are the event source
// mapping's job instead of a hand-rolled loop. Built for x86_64 so the
// demo lane runs the exact instruction set the Fargate fleets were
// parity- and chaos-tested on.
//
// Error semantics with batch size 1: returning an error puts the one
// message back on the queue; after maxReceiveCount deliveries SQS parks
// it in the DLQ and the CloudWatch alarm emails. That covers malformed
// messages too - unlike the poll worker there is no delete-and-move-on
// branch, because the DLQ redrive is the drop path here.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"wealthos/go-worker/internal/sim"
	"wealthos/go-worker/internal/storage"
)

type app struct {
	store    *storage.Store
	workerID string
}

func (a *app) handleEvent(ctx context.Context, event events.SQSEvent) error {
	for _, record := range event.Records {
		spec, err := sim.ParseChunkSpec([]byte(record.Body))
		if err != nil {
			return fmt.Errorf("malformed chunk message: %w", err)
		}
		started := time.Now()
		summary := sim.SimulateChunk(spec)
		summary.ComputeMs = float64(time.Since(started)) / float64(time.Millisecond)
		summary.WorkerID = a.workerID
		if err := a.store.PutChunkSummary(ctx, summary); err != nil {
			return fmt.Errorf("put chunk summary (job=%s chunk=%d): %w",
				spec.JobID, spec.ChunkIndex, err)
		}
		log.Printf("[%s] job=%s chunk=%d paths=%d %dms",
			a.workerID, spec.JobID, spec.ChunkIndex, spec.PathCount, int(summary.ComputeMs))
	}
	return nil
}

func newWorkerID() string {
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		log.Fatalf("workerId entropy: %v", err)
	}
	return "lambda-go-" + hex.EncodeToString(suffix)
}

func main() {
	bucket := os.Getenv("WEALTHSIM_BUCKET")
	if bucket == "" {
		log.Fatal("WEALTHSIM_BUCKET must be set")
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}

	cfg, err := config.LoadDefaultConfig(context.Background(), config.WithRegion(region))
	if err != nil {
		log.Fatalf("aws config: %v", err)
	}
	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if endpoint := os.Getenv("S3_ENDPOINT"); endpoint != "" {
			// MinIO needs path-style addressing (no per-bucket DNS)
			o.BaseEndpoint = aws.String(endpoint)
			o.UsePathStyle = true
		}
	})

	worker := &app{store: storage.New(s3Client, bucket), workerID: newWorkerID()}
	lambda.Start(worker.handleEvent)
}
