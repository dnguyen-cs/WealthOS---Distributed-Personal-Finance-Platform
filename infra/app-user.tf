# Credentials for the hosted app (Vercel serverless functions). The app's
# AWS surface is deliberately tiny: enqueue chunk messages onto the demo
# queues, and read chunk summaries back during aggregation-on-read. It can
# not touch the Batch lane, delete objects, or consume any queue.
#
# The access key is NOT managed here: run
#   aws iam create-access-key --user-name wealthos-app
# once and paste the pair into Vercel env, so the secret never enters
# Terraform state. (Planned upgrade: Vercel OIDC federation to an
# assumable role, removing the long-lived key entirely.)
resource "aws_iam_user" "wealthos_app" {
  name = "wealthos-app"
}

data "aws_iam_policy_document" "wealthos_app" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [for queue in aws_sqs_queue.wealthsim_demo : queue.arn]
  }

  # PortfolioPulse: read the market data, start ingest sessions, and write
  # only the SESSION partition (the viewer keepalive) - market data and
  # checkpoints stay read-only from the app's credentials.
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.pulse.arn]
  }

  statement {
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.pulse.arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["SESSION"]
    }
  }

  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.pulse["ingest"].arn]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.wealthsim_results.arn}/jobs/*"]
  }

  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.wealthsim_results.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["jobs/*"]
    }
  }
}

resource "aws_iam_user_policy" "wealthos_app" {
  name   = "wealthos-app"
  user   = aws_iam_user.wealthos_app.name
  policy = data.aws_iam_policy_document.wealthos_app.json
}
