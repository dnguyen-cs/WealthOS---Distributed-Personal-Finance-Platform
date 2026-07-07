# Cost seatbelt for the whole account: this project's steady-state design
# cost is $0 idle (no NAT, self-terminating Batch workers, S3 lifecycle
# expiry), so any sustained spend is a mistake worth an email.
resource "aws_budgets_budget" "monthly" {
  name         = "wealthos-monthly"
  budget_type  = "COST"
  limit_amount = "15"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = ["danielnmatt@gmail.com"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = ["danielnmatt@gmail.com"]
  }
}
