// WealthSim compute worker, Go edition: the same contract as
// src/workers/wealthsim/main.ts (pull chunk specs from SQS, run the Monte
// Carlo kernel, write one summary object per chunk to object storage),
// consumed from the engine-specific queue the app routes `engine: "go"`
// jobs onto.
//
// Deliberately stateless - no database, no Redis - and byte-for-byte
// compatible with the Node worker's S3 output contract, so the app's
// aggregation-on-read path cannot tell the engines apart.
//
// Environment:
//
//	WEALTHSIM_QUEUE_URL        (required) queue to consume
//	WEALTHSIM_BUCKET           (required) results bucket
//	AWS_REGION                 default us-east-1
//	SQS_ENDPOINT, S3_ENDPOINT  emulator overrides (ElasticMQ/MinIO); unset on AWS
//	WORKER_IDLE_EXIT_SECONDS   exit after the queue is empty this long (0 = poll forever);
//	                           on AWS this MUST exceed the queue's visibility timeout
//	GOWORKER_CONCURRENCY       independent poll-process loops (default 1); >1 only
//	                           pays off on multi-vCPU tasks - the kernel is CPU-bound
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/smithy-go"

	"wealthos/go-worker/internal/sim"
	"wealthos/go-worker/internal/storage"
)

func requireEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("%s must be set", name)
	}
	return value
}

func envInt(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		log.Fatalf("%s must be an integer, got %q", name, raw)
	}
	return value
}

func newWorkerID() string {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown-host"
	}
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		log.Fatalf("workerId entropy: %v", err)
	}
	return fmt.Sprintf("%s-%s", hostname, hex.EncodeToString(suffix))
}

// ensureLocalBucket mirrors the Node worker: on real AWS the bucket is
// provisioned by Terraform and workers have no CreateBucket permission,
// so this only runs against a local emulator (S3_ENDPOINT set).
func ensureLocalBucket(ctx context.Context, client *s3.Client, bucket string) error {
	if os.Getenv("S3_ENDPOINT") == "" {
		return nil
	}
	_, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)})
	if err != nil {
		var owned *s3types.BucketAlreadyOwnedByYou
		var exists *s3types.BucketAlreadyExists
		if errors.As(err, &owned) || errors.As(err, &exists) {
			return nil
		}
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) &&
			(apiErr.ErrorCode() == "BucketAlreadyOwnedByYou" || apiErr.ErrorCode() == "BucketAlreadyExists") {
			return nil
		}
		return err
	}
	return nil
}

func main() {
	workerID := newWorkerID()
	queueURL := requireEnv("WEALTHSIM_QUEUE_URL")
	bucket := requireEnv("WEALTHSIM_BUCKET")
	idleExit := time.Duration(envInt("WORKER_IDLE_EXIT_SECONDS", 0)) * time.Second
	concurrency := envInt("GOWORKER_CONCURRENCY", 1)
	if concurrency < 1 {
		concurrency = 1
	}

	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}

	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		log.Fatalf("[%s] aws config: %v", workerID, err)
	}

	sqsClient := sqs.NewFromConfig(cfg, func(o *sqs.Options) {
		if endpoint := os.Getenv("SQS_ENDPOINT"); endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
		}
	})
	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if endpoint := os.Getenv("S3_ENDPOINT"); endpoint != "" {
			// MinIO needs path-style addressing (no per-bucket DNS)
			o.BaseEndpoint = aws.String(endpoint)
			o.UsePathStyle = true
		}
	})

	if err := ensureLocalBucket(ctx, s3Client, bucket); err != nil {
		log.Fatalf("[%s] ensure bucket: %v", workerID, err)
	}

	var shuttingDown atomic.Bool
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		received := <-signals
		log.Printf("[%s] received %s, finishing current chunk", workerID, received)
		shuttingDown.Store(true)
	}()

	store := storage.New(s3Client, bucket)
	log.Printf("[%s] polling %s (concurrency %d)", workerID, queueURL, concurrency)

	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runLoop(ctx, workerID, sqsClient, queueURL, store, idleExit, &shuttingDown)
		}()
	}
	wg.Wait()
	log.Printf("[%s] shut down cleanly", workerID)
}

func runLoop(
	ctx context.Context,
	workerID string,
	sqsClient *sqs.Client,
	queueURL string,
	store *storage.Store,
	idleExit time.Duration,
	shuttingDown *atomic.Bool,
) {
	idleSince := time.Now()
	for !shuttingDown.Load() {
		received, err := sqsClient.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:            aws.String(queueURL),
			MaxNumberOfMessages: 1,
			WaitTimeSeconds:     20,
		})
		if err != nil {
			log.Printf("[%s] receive failed, backing off: %v", workerID, err)
			time.Sleep(5 * time.Second)
			continue
		}
		if len(received.Messages) == 0 {
			if idleExit > 0 && time.Since(idleSince) >= idleExit {
				log.Printf("[%s] queue idle for %s, exiting", workerID, idleExit)
				return
			}
			continue
		}
		idleSince = time.Now()
		message := received.Messages[0]

		spec, err := sim.ParseChunkSpec([]byte(aws.ToString(message.Body)))
		if err != nil {
			// A malformed message can never succeed; deleting it beats
			// letting it cycle through redelivery forever. On AWS the DLQ
			// redrive policy catches these before this branch does.
			log.Printf("[%s] dropping malformed message: %v", workerID, err)
			deleteMessage(ctx, workerID, sqsClient, queueURL, message.ReceiptHandle)
			continue
		}

		started := time.Now()
		summary := sim.SimulateChunk(spec)
		summary.ComputeMs = float64(time.Since(started)) / float64(time.Millisecond)
		summary.WorkerID = workerID

		if err := store.PutChunkSummary(ctx, summary); err != nil {
			// Leave the message in flight; it reappears after the
			// visibility timeout and another worker (or this one) retries.
			log.Printf("[%s] chunk failed (job=%s chunk=%d), will retry: %v",
				workerID, spec.JobID, spec.ChunkIndex, err)
			continue
		}
		deleteMessage(ctx, workerID, sqsClient, queueURL, message.ReceiptHandle)

		rate := int(float64(spec.PathCount) / (summary.ComputeMs / 1000))
		log.Printf("[%s] job=%s chunk=%d paths=%d %dms (%s paths/s)",
			workerID, spec.JobID, spec.ChunkIndex, spec.PathCount,
			int(summary.ComputeMs), groupDigits(rate))
	}
}

func deleteMessage(ctx context.Context, workerID string, client *sqs.Client, queueURL string, receiptHandle *string) {
	_, err := client.DeleteMessage(ctx, &sqs.DeleteMessageInput{
		QueueUrl:      aws.String(queueURL),
		ReceiptHandle: receiptHandle,
	})
	if err != nil {
		// The visibility timeout will re-expose the message; reprocessing
		// is idempotent, so a failed delete costs duplicate work, not
		// correctness.
		log.Printf("[%s] delete failed (message will redeliver): %v", workerID, err)
	}
}

// groupDigits formats 1234567 as "1,234,567" (log readability parity with
// the Node worker's toLocaleString).
func groupDigits(value int) string {
	digits := strconv.Itoa(value)
	if value < 0 {
		return "-" + groupDigits(-value)
	}
	var out []byte
	for i, d := range []byte(digits) {
		if i > 0 && (len(digits)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, d)
	}
	return string(out)
}
