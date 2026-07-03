provider "aws" {
  region = "us-east-1"
}

resource "aws_vpc" "wealth_os" {
  cidr_block = "10.0.0.0/16"

  tags = {
    Name = "WealthOS_VPC"
  }
}

