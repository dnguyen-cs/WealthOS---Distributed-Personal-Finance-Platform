# The demo lane: scale-to-zero Lambda chunk consumers, one per engine,
# each on its own queue pair. The Batch lane (wealthsim-jobs*) stays
# reserved for benchmarks; the app picks a lane purely through its
# WEALTHSIM_QUEUE_URL / WEALTHSIM_QUEUE_URL_GO env, so a public demo user
# can never contend with a benchmark fleet and no toggling is needed.
#
# Artifacts come from `pnpm build:lambdas` (dist/lambda/{node,go}.zip),
# built for x86_64 to match the Fargate fleets bit for bit - the demo lane
# inherits the parity and chaos results measured there.

locals {
  demo_engines = {
    node = {
      runtime  = "nodejs22.x"
      handler  = "index.handler"
      artifact = "${path.module}/../dist/lambda/node.zip"
    }
    go = {
      runtime  = "provided.al2023"
      handler  = "bootstrap"
      artifact = "${path.module}/../dist/lambda/go.zip"
    }
  }

  # Per-engine parallelism cap, enforced by the event source mapping's
  # maximum_concurrency. Deliberately NOT reserved function concurrency:
  # the account's quota is now 1,000 (Service Quotas increase approved
  # 2026-07-18; the new-account limit of 10 is what tainted the first
  # apply), so there is no contended pool to reserve against, and a
  # reservation would only add a second cap mechanism plus the
  # 100-unreserved headroom rule. 16 + 16 keeps race mode fair and
  # bounds the demo lane's blast radius at 32 concurrent executions.
  demo_concurrency = 16
}

resource "aws_sqs_queue" "wealthsim_demo" {
  for_each = local.demo_engines

  name = "wealthsim-demo-${each.key}"
  # >= 6x the function timeout per AWS guidance for Lambda ESM consumers;
  # also the worst-case redelivery delay if an invocation dies mid-chunk.
  visibility_timeout_seconds = 180
  message_retention_seconds  = 86400 # 1 day; chunk specs are worthless stale

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.wealthsim_demo_dlq[each.key].arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "wealthsim_demo_dlq" {
  for_each = local.demo_engines

  name                      = "wealthsim-demo-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 days to inspect poison messages
}

# Same tripwire as the Batch lane: anything in a DLQ pages by email.
resource "aws_cloudwatch_metric_alarm" "wealthsim_demo_dlq_not_empty" {
  for_each = local.demo_engines

  alarm_name          = "wealthsim-demo-dlq-${each.key}-not-empty"
  alarm_description   = "A demo-lane ${each.key} chunk message exhausted its 5 delivery attempts"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.wealthsim_demo_dlq[each.key].name
  }

  alarm_actions = [aws_sns_topic.wealthsim_alerts.arn]
}

data "aws_iam_policy_document" "wealthsim_demo_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "wealthsim_demo" {
  for_each = local.demo_engines

  name               = "wealthsim-demo-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.wealthsim_demo_assume.json
}

# Least privilege, mirroring the Batch task role: consume exactly one
# queue, write results only under jobs/, and log.
data "aws_iam_policy_document" "wealthsim_demo" {
  for_each = local.demo_engines

  statement {
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.wealthsim_demo[each.key].arn]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.wealthsim_results.arn}/jobs/*"]
  }

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.wealthsim_demo[each.key].arn}:*"]
  }
}

resource "aws_iam_role_policy" "wealthsim_demo" {
  for_each = local.demo_engines

  name   = "wealthsim-demo-${each.key}"
  role   = aws_iam_role.wealthsim_demo[each.key].id
  policy = data.aws_iam_policy_document.wealthsim_demo[each.key].json
}

# Explicit log groups so retention is bounded (Lambda's auto-created
# groups default to never-expire).
resource "aws_cloudwatch_log_group" "wealthsim_demo" {
  for_each = local.demo_engines

  name              = "/aws/lambda/wealthsim-demo-${each.key}"
  retention_in_days = 14
}

resource "aws_lambda_function" "wealthsim_demo" {
  for_each = local.demo_engines

  function_name = "wealthsim-demo-${each.key}"
  role          = aws_iam_role.wealthsim_demo[each.key].arn
  runtime       = each.value.runtime
  handler       = each.value.handler
  architectures = ["x86_64"]

  # 1769 MB is Lambda's documented 1-full-vCPU point, so per-chunk compute
  # times are directly comparable with the 1-vCPU Fargate workers.
  memory_size = 1769
  # A 50K-path chunk computes in under a second; 30s is retry headroom for
  # the S3 put, not compute headroom.
  timeout = 30

  filename         = each.value.artifact
  source_code_hash = filebase64sha256(each.value.artifact)

  environment {
    variables = {
      WEALTHSIM_BUCKET = aws_s3_bucket.wealthsim_results.bucket
    }
  }

  depends_on = [aws_cloudwatch_log_group.wealthsim_demo]
}

# Batch size 1: a chunk is already the unit of work and retry; batching
# would serialize chunks inside one invocation and couple their failures.
resource "aws_lambda_event_source_mapping" "wealthsim_demo" {
  for_each = local.demo_engines

  event_source_arn = aws_sqs_queue.wealthsim_demo[each.key].arn
  function_name    = aws_lambda_function.wealthsim_demo[each.key].arn
  batch_size       = 1

  scaling_config {
    maximum_concurrency = local.demo_concurrency
  }
}

output "wealthsim_demo_queue_url" {
  description = "Demo-lane node queue - hosted app WEALTHSIM_QUEUE_URL"
  value       = aws_sqs_queue.wealthsim_demo["node"].url
}

output "wealthsim_demo_queue_url_go" {
  description = "Demo-lane go queue - hosted app WEALTHSIM_QUEUE_URL_GO"
  value       = aws_sqs_queue.wealthsim_demo["go"].url
}
