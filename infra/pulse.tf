# PortfolioPulse streaming plane. Deliberate exclusions, per the $0-idle
# rule: the Kinesis stream and the consumer's event source mapping are NOT
# managed here - a provisioned shard and an active mapping bill hourly, so
# the ingest Lambda creates both lazily on the first "Go live" of the day
# and the janitor deletes them after idle hours (SDK lifecycle, IAM'd
# below). Terraform owns everything durable-and-free: the table, the three
# functions, their roles, the DLQ, the alarm, and the janitor schedule.
#
# Artifacts come from `pnpm build:lambdas` (dist/lambda/pulse-*.zip).

locals {
  pulse_stream_name = "pulse-events"
  pulse_stream_arn  = "arn:aws:kinesis:us-east-1:${data.aws_caller_identity.current.account_id}:stream/${local.pulse_stream_name}"

  pulse_functions = {
    ingest = {
      artifact = "${path.module}/../dist/lambda/pulse-ingest.zip"
      # Holds the exchange websocket for a whole session.
      timeout     = 900
      memory_size = 1024
    }
    consumer = {
      artifact    = "${path.module}/../dist/lambda/pulse-consumer.zip"
      timeout     = 60
      memory_size = 512
    }
    janitor = {
      artifact    = "${path.module}/../dist/lambda/pulse-janitor.zip"
      timeout     = 60
      memory_size = 256
    }
  }
}

resource "aws_dynamodb_table" "pulse" {
  name         = "pulse"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

# Failed consumer batches (after 3 retries + bisect) land here; same
# email tripwire as the WealthSim DLQs.
resource "aws_sqs_queue" "pulse_dlq" {
  name                      = "pulse-dlq"
  message_retention_seconds = 1209600 # 14 days to inspect poison batches
}

resource "aws_cloudwatch_metric_alarm" "pulse_dlq_not_empty" {
  alarm_name          = "pulse-dlq-not-empty"
  alarm_description   = "A pulse consumer batch exhausted its retries"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.pulse_dlq.name
  }

  alarm_actions = [aws_sns_topic.wealthsim_alerts.arn]
}

resource "aws_cloudwatch_log_group" "pulse" {
  for_each = local.pulse_functions

  name              = "/aws/lambda/pulse-${each.key}"
  retention_in_days = 14
}

data "aws_iam_policy_document" "pulse_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pulse" {
  for_each = local.pulse_functions

  name               = "pulse-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.pulse_assume.json
}

# Ingest: create/inspect the stream and write records; manage the
# consumer's mapping (scoped to that one function); own the SESSION
# partition of the table (lease + viewers), nothing else.
data "aws_iam_policy_document" "pulse_ingest" {
  statement {
    actions = [
      "kinesis:CreateStream",
      "kinesis:DescribeStreamSummary",
      "kinesis:PutRecords",
    ]
    resources = [local.pulse_stream_arn]
  }

  statement {
    actions   = ["lambda:CreateEventSourceMapping"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "lambda:FunctionArn"
      values   = [aws_lambda_function.pulse["consumer"].arn]
    }
  }

  statement {
    actions   = ["lambda:ListEventSourceMappings"]
    resources = ["*"]
  }

  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.pulse.arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["SESSION"]
    }
  }

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.pulse["ingest"].arn}:*"]
  }
}

# Consumer: read the stream (the mapping's poller runs as this role),
# write the table, and deliver failed batches to the DLQ.
data "aws_iam_policy_document" "pulse_consumer" {
  statement {
    actions = [
      "kinesis:DescribeStream",
      "kinesis:DescribeStreamSummary",
      "kinesis:GetRecords",
      "kinesis:GetShardIterator",
      "kinesis:ListShards",
    ]
    resources = [local.pulse_stream_arn]
  }

  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.pulse.arn]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.pulse_dlq.arn]
  }

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.pulse["consumer"].arn}:*"]
  }
}

# Janitor: inspect activity, then delete the mapping and the stream.
data "aws_iam_policy_document" "pulse_janitor" {
  statement {
    actions   = ["kinesis:DescribeStreamSummary", "kinesis:DeleteStream"]
    resources = [local.pulse_stream_arn]
  }

  statement {
    actions   = ["lambda:ListEventSourceMappings", "lambda:DeleteEventSourceMapping"]
    resources = ["*"]
  }

  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.pulse.arn]
  }

  # Checkpoints are stream-scoped state: when the janitor deletes the
  # stream it also clears the SHARD# checkpoint items, so nothing stale
  # survives into a recreated stream.
  statement {
    actions   = ["dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.pulse.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["SHARD#*"]
    }
  }

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.pulse["janitor"].arn}:*"]
  }
}

resource "aws_iam_role_policy" "pulse" {
  for_each = {
    ingest   = data.aws_iam_policy_document.pulse_ingest.json
    consumer = data.aws_iam_policy_document.pulse_consumer.json
    janitor  = data.aws_iam_policy_document.pulse_janitor.json
  }

  name   = "pulse-${each.key}"
  role   = aws_iam_role.pulse[each.key].id
  policy = each.value
}

resource "aws_lambda_function" "pulse" {
  for_each = local.pulse_functions

  function_name = "pulse-${each.key}"
  role          = aws_iam_role.pulse[each.key].arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["x86_64"]
  memory_size   = each.value.memory_size
  timeout       = each.value.timeout

  filename         = each.value.artifact
  source_code_hash = filebase64sha256(each.value.artifact)

  # No reserved concurrency anywhere: the account's 10-concurrency
  # starter limit makes reservations impossible (AWS requires 100 left
  # unreserved). Single-flight ingest is enforced by the DynamoDB lease.

  environment {
    variables = merge(
      {
        PULSE_TABLE  = aws_dynamodb_table.pulse.name
        PULSE_STREAM = local.pulse_stream_name
      },
      each.key == "ingest" ? {
        PULSE_CONSUMER_FUNCTION = "pulse-consumer"
        PULSE_DLQ_ARN           = aws_sqs_queue.pulse_dlq.arn
        PULSE_SOURCE            = "coinbase"
      } : {},
      each.key == "janitor" ? {
        PULSE_CONSUMER_FUNCTION = "pulse-consumer"
      } : {},
    )
  }

  depends_on = [aws_cloudwatch_log_group.pulse]
}

resource "aws_cloudwatch_event_rule" "pulse_janitor" {
  name                = "pulse-janitor-daily"
  description         = "Tear down the pulse stream + mapping after idle hours"
  schedule_expression = "rate(1 day)"
}

resource "aws_cloudwatch_event_target" "pulse_janitor" {
  rule = aws_cloudwatch_event_rule.pulse_janitor.name
  arn  = aws_lambda_function.pulse["janitor"].arn
}

resource "aws_lambda_permission" "pulse_janitor" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pulse["janitor"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.pulse_janitor.arn
}

output "pulse_table" {
  description = "DynamoDB table - hosted app PULSE_TABLE"
  value       = aws_dynamodb_table.pulse.name
}

output "pulse_ingest_function" {
  description = "Ingest Lambda - hosted app PULSE_INGEST_FUNCTION"
  value       = aws_lambda_function.pulse["ingest"].function_name
}
