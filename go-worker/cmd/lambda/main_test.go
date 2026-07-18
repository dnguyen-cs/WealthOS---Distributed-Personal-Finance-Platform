package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"wealthos/go-worker/internal/sim"
	"wealthos/go-worker/internal/storage"
)

// End-to-end wiring test for the Lambda handler: a real SQS-shaped event
// through parse -> kernel -> object storage, against the local MinIO
// emulator. Self-skips when no emulator is configured (CI), the same
// convention as the parity tests' testdata skip.
func newTestApp(t *testing.T) (*app, *s3.Client, string) {
	t.Helper()
	endpoint := os.Getenv("S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("S3_ENDPOINT not set; start the compose objectstore to run this test")
	}
	bucket := os.Getenv("WEALTHSIM_BUCKET")
	if bucket == "" {
		bucket = "wealthsim-local"
	}

	cfg, err := config.LoadDefaultConfig(context.Background(), config.WithRegion("us-east-1"))
	if err != nil {
		t.Fatalf("aws config: %v", err)
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
		o.UsePathStyle = true
	})
	// Idempotent against the compose workers having created it already.
	_, _ = client.CreateBucket(context.Background(), &s3.CreateBucketInput{Bucket: aws.String(bucket)})

	return &app{store: storage.New(client, bucket), workerID: "lambda-go-test"}, client, bucket
}

func TestHandleEventWritesSummary(t *testing.T) {
	worker, client, bucket := newTestApp(t)

	spec := sim.ChunkSpec{
		JobID:      "lambda-selftest-go",
		ChunkIndex: 3,
		PathCount:  50_000,
		Seed:       20260717,
		Params: sim.ModelParams{
			InitialValue:       100_000,
			AnnualContribution: 12_000,
			MeanReturn:         0.07,
			Volatility:         0.15,
			Years:              30,
		},
	}
	body, err := json.Marshal(spec)
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}

	event := events.SQSEvent{Records: []events.SQSMessage{{Body: string(body)}}}
	if err := worker.handleEvent(context.Background(), event); err != nil {
		t.Fatalf("handleEvent: %v", err)
	}

	object, err := client.GetObject(context.Background(), &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(storage.ChunkKey(spec.JobID, spec.ChunkIndex)),
	})
	if err != nil {
		t.Fatalf("get summary object: %v", err)
	}
	defer object.Body.Close()
	raw, err := io.ReadAll(object.Body)
	if err != nil {
		t.Fatalf("read summary object: %v", err)
	}

	var summary sim.ChunkSummary
	if err := json.Unmarshal(raw, &summary); err != nil {
		t.Fatalf("summary is not valid JSON: %v", err)
	}
	switch {
	case summary.JobID != spec.JobID:
		t.Fatalf("jobId = %q, want %q", summary.JobID, spec.JobID)
	case summary.ChunkIndex != spec.ChunkIndex:
		t.Fatalf("chunkIndex = %d, want %d", summary.ChunkIndex, spec.ChunkIndex)
	case summary.PathCount != spec.PathCount:
		t.Fatalf("pathCount = %d, want %d", summary.PathCount, spec.PathCount)
	case summary.WorkerID != "lambda-go-test":
		t.Fatalf("workerId = %q, want lambda-go-test", summary.WorkerID)
	case len(summary.Years) != spec.Params.Years:
		t.Fatalf("years = %d, want %d", len(summary.Years), spec.Params.Years)
	}
}

func TestHandleEventRejectsMalformedMessage(t *testing.T) {
	worker, _, _ := newTestApp(t)

	event := events.SQSEvent{Records: []events.SQSMessage{{Body: `{"jobId":""}`}}}
	if err := worker.handleEvent(context.Background(), event); err == nil {
		t.Fatal("expected an error for a malformed message (redelivery -> DLQ path)")
	}
}
