output "wealthsim_queue_url" {
  description = "SQS queue URL - app WEALTHSIM_QUEUE_URL"
  value       = aws_sqs_queue.wealthsim_jobs.url
}

output "wealthsim_bucket" {
  description = "S3 bucket for chunk summaries - app WEALTHSIM_BUCKET"
  value       = aws_s3_bucket.wealthsim_results.bucket
}

output "wealthsim_ecr_repository_url" {
  description = "Push the worker image here (docker/Dockerfile.worker)"
  value       = aws_ecr_repository.wealthsim_worker.repository_url
}

output "wealthsim_job_queue" {
  description = "Batch job queue name for aws batch submit-job"
  value       = aws_batch_job_queue.wealthsim.name
}

output "wealthsim_job_definition" {
  description = "Batch job definition name for aws batch submit-job"
  value       = aws_batch_job_definition.wealthsim_worker.name
}
