# Production-error visibility for a system with no always-on servers.
# The compute plane's failure signals concentrate in two places: the
# budget alarm (budget.tf) catches runaway spend, and the DLQs catch
# poison messages - a chunk spec that failed maxReceiveCount (5) deliveries
# means a worker bug or a malformed producer, never normal operation.
# Any message landing in either DLQ pages by email within a minute.
resource "aws_sns_topic" "wealthsim_alerts" {
  name = "wealthsim-alerts"
}

# NOTE: SNS email subscriptions require a one-time confirmation click in
# the inbox before deliveries flow.
resource "aws_sns_topic_subscription" "wealthsim_alerts_email" {
  topic_arn = aws_sns_topic.wealthsim_alerts.arn
  protocol  = "email"
  endpoint  = "danielnmatt@gmail.com"
}

locals {
  wealthsim_dlqs = {
    node = aws_sqs_queue.wealthsim_jobs_dlq.name
    go   = aws_sqs_queue.wealthsim_jobs_go_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "wealthsim_dlq_not_empty" {
  for_each = local.wealthsim_dlqs

  alarm_name          = "wealthsim-dlq-${each.key}-not-empty"
  alarm_description   = "A ${each.key}-engine chunk message exhausted its 5 delivery attempts"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  # SQS only emits metrics for active queues; a silent DLQ is a healthy DLQ
  treat_missing_data = "notBreaching"

  dimensions = {
    QueueName = each.value
  }

  alarm_actions = [aws_sns_topic.wealthsim_alerts.arn]
}
