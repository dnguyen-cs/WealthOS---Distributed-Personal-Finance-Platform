data "aws_caller_identity" "current" {}

# Standard queue, not FIFO: FIFO serializes a message group while one
# message is in flight, which would defeat per-chunk fan-out. Chunk
# processing is idempotent by construction (deterministic seed -> same
# output object key), so at-least-once delivery is safe.
resource "aws_sqs_queue" "wealthsim_jobs" {
  name                       = "wealthsim-jobs"
  visibility_timeout_seconds = 300
  message_retention_seconds  = 86400 # 1 day; chunk specs are worthless stale

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.wealthsim_jobs_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "wealthsim_jobs_dlq" {
  name                      = "wealthsim-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days to inspect poison messages
}

resource "aws_s3_bucket" "wealthsim_results" {
  # account id suffix for global uniqueness
  bucket = "wealthos-wealthsim-${data.aws_caller_identity.current.account_id}"

  # resume project: allow clean teardown even with objects present
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "wealthsim_results" {
  bucket = aws_s3_bucket.wealthsim_results.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "wealthsim_results" {
  bucket = aws_s3_bucket.wealthsim_results.id

  rule {
    id     = "expire-chunk-summaries"
    status = "Enabled"

    filter {
      prefix = "jobs/"
    }

    # chunk summaries only matter until the job row is finalized in
    # Postgres; 30 days is generous headroom for debugging
    expiration {
      days = 30
    }
  }
}

resource "aws_ecr_repository" "wealthsim_worker" {
  name         = "wealthsim-worker"
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }
}
