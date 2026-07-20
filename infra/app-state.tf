# App coordination state: rate-limit windows, the global daily path
# budget, and the Plaid sync lock - everything that lived in Redis before
# the stack became Vercel + AWS only. Single-key items with a TTL
# attribute; expiry is enforced by conditional writes in the app
# (lib/app-state.ts), TTL here is only garbage collection.
resource "aws_dynamodb_table" "app_state" {
  name         = "app-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

output "app_state_table" {
  description = "DynamoDB table for rate limits, budgets, and locks - hosted app APP_STATE_TABLE"
  value       = aws_dynamodb_table.app_state.name
}
