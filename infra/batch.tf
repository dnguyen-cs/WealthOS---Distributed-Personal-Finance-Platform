# AWS Batch on Fargate runs the WealthSim workers. A benchmark run
# submits N copies of the worker job; each polls the queue, writes chunk
# summaries to S3, and exits after WORKER_IDLE_EXIT_SECONDS of empty
# receives, so a fleet drains the queue and terminates itself.

resource "aws_cloudwatch_log_group" "wealthsim_worker" {
  name              = "/wealthos/wealthsim-worker"
  retention_in_days = 14
}

# --- IAM ---

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: what the Fargate agent needs (pull image, ship logs)
resource "aws_iam_role" "wealthsim_execution" {
  name               = "wealthsim-worker-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "wealthsim_execution" {
  role       = aws_iam_role.wealthsim_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Task role: what the worker code itself may do - exactly queue
# consumption and result writes, nothing else
resource "aws_iam_role" "wealthsim_task" {
  name               = "wealthsim-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "wealthsim_task" {
  statement {
    sid = "ConsumeQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.wealthsim_jobs.arn]
  }

  statement {
    sid       = "WriteChunkSummaries"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.wealthsim_results.arn}/jobs/*"]
  }
}

resource "aws_iam_role_policy" "wealthsim_task" {
  name   = "wealthsim-worker-task"
  role   = aws_iam_role.wealthsim_task.id
  policy = data.aws_iam_policy_document.wealthsim_task.json
}

# Role Batch uses to manage compute on our behalf
resource "aws_iam_role" "batch_service" {
  name = "wealthsim-batch-service"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "batch.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "batch_service" {
  role       = aws_iam_role.batch_service.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole"
}

# --- Batch ---

resource "aws_batch_compute_environment" "wealthsim" {
  name         = "wealthsim-fargate"
  type         = "MANAGED"
  service_role = aws_iam_role.batch_service.arn

  compute_resources {
    type               = "FARGATE"
    max_vcpus          = 64
    security_group_ids = [aws_security_group.wealthsim_worker.id]
    subnets            = aws_subnet.public[*].id
  }

  depends_on = [aws_iam_role_policy_attachment.batch_service]
}

resource "aws_batch_job_queue" "wealthsim" {
  name     = "wealthsim"
  state    = "ENABLED"
  priority = 1

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.wealthsim.arn
  }
}

resource "aws_batch_job_definition" "wealthsim_worker" {
  name                  = "wealthsim-worker"
  type                  = "container"
  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.wealthsim_worker.repository_url}:latest"
    executionRoleArn = aws_iam_role.wealthsim_execution.arn
    jobRoleArn       = aws_iam_role.wealthsim_task.arn

    resourceRequirements = [
      { type = "VCPU", value = "1" },
      { type = "MEMORY", value = "2048" },
    ]

    networkConfiguration = {
      assignPublicIp = "ENABLED"
    }

    environment = [
      { name = "WEALTHSIM_QUEUE_URL", value = aws_sqs_queue.wealthsim_jobs.url },
      { name = "WEALTHSIM_BUCKET", value = aws_s3_bucket.wealthsim_results.bucket },
      { name = "AWS_REGION", value = "us-east-1" },
      { name = "WORKER_IDLE_EXIT_SECONDS", value = "60" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.wealthsim_worker.name
        "awslogs-region"        = "us-east-1"
        "awslogs-stream-prefix" = "worker"
      }
    }
  })

  retry_strategy {
    attempts = 2
  }

  timeout {
    # hard stop: no worker should ever live longer than an hour
    attempt_duration_seconds = 3600
  }
}
