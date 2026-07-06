data "aws_availability_zones" "available" {
  state = "available"
}

# Two public subnets across AZs. Batch/Fargate tasks run here with public
# IPs and an egress-only security group rather than in private subnets
# behind a NAT gateway: the workers only make outbound calls (SQS, S3,
# ECR pulls), and a NAT gateway costs ~$32/month idle, which this
# burst-benchmark workload cannot justify.
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.wealth_os.id
  cidr_block              = cidrsubnet(aws_vpc.wealth_os.cidr_block, 8, count.index + 1)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "WealthOS_Public_${count.index + 1}"
  }
}

resource "aws_internet_gateway" "wealth_os" {
  vpc_id = aws_vpc.wealth_os.id

  tags = {
    Name = "WealthOS_IGW"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.wealth_os.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.wealth_os.id
  }

  tags = {
    Name = "WealthOS_Public_RT"
  }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "wealthsim_worker" {
  name        = "wealthsim-worker"
  description = "WealthSim Batch workers: outbound only"
  vpc_id      = aws_vpc.wealth_os.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "WealthOS_WealthSim_Worker"
  }
}
