terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # S3-native state locking (Terraform >= 1.10) instead of a DynamoDB
  # lock table; bucket is versioned for state history
  backend "s3" {
    bucket       = "wealthos-tfstate-991055922592"
    key          = "wealthos/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }

  required_version = ">= 1.10"
}