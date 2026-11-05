# Aurora Serverless v2 Postgres for the hosted app. min_capacity 0
# auto-pauses database compute after 5 idle minutes; the tradeoff is a
# ~14s resume for the first query after a pause (accepted by decision,
# measured at 13.7s). The public endpoint's IPv4 charge and the Route 53
# hosted-zone charge remain a small monthly deployment floor. Engine 16.13
# keeps major-version parity with the local postgres:16 container.
#
# Reachability: Vercel functions have no stable egress identity, so the
# instance is publicly accessible with the security group open on 5432 -
# the perimeter is TLS (rds.force_ssl below) plus the master password,
# which is rotated OUTSIDE Terraform right after the first apply
# (`aws rds modify-db-cluster --master-user-password ...`) so the real
# secret never sits in tfstate.

resource "aws_db_subnet_group" "app" {
  name       = "wealthos-app"
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_security_group" "aurora" {
  name        = "wealthos-aurora"
  description = "Aurora Postgres for the hosted app: public 5432, TLS enforced at the engine"
  vpc_id      = aws_vpc.wealth_os.id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "WealthOS_Aurora"
  }
}

resource "aws_rds_cluster_parameter_group" "app" {
  name   = "wealthos-app-pg16"
  family = "aurora-postgresql16"

  # Reject any non-TLS connection outright; with a public endpoint this
  # is the difference between "open port" and "TLS-only service".
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_rds_cluster" "app" {
  cluster_identifier              = "wealthos-app"
  engine                          = "aurora-postgresql"
  engine_mode                     = "provisioned" # serverless v2 uses provisioned mode + db.serverless instances
  engine_version                  = "16.13"
  database_name                   = "wealthos"
  master_username                 = "wealthos"
  master_password                 = "rotate-me-immediately" # placeholder; rotated outside tfstate, see header
  db_subnet_group_name            = aws_db_subnet_group.app.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.app.name
  storage_encrypted               = true
  backup_retention_period         = 7
  deletion_protection             = true

  serverlessv2_scaling_configuration {
    min_capacity = 0 # pauses compute when idle; see the wake note below
    # Measured 2026-08-28: 0.00 ACU-hours were sustained above 1.0 ACU over a
    # week, so the brief resume spikes cost nothing worth capping. The headroom
    # is free to keep, and 2 leaves room for a demo sync burst.
    max_capacity = 2
    # 300s (the minimum) rather than 600s. min_capacity 0 pauses compute but
    # does not make it free: Aurora wakes roughly every two hours for internal
    # background work with zero client connections (measured over a week: only
    # 4 of 76 awake buckets carried a connection), and each wake is billed for
    # the whole auto-pause window. Halving the window halves that dead tail,
    # ~$1.44/month. The cost is a visitor idling past 5 minutes mid-session
    # paying the 13.7s resume again instead of getting 10 minutes of grace.
    seconds_until_auto_pause = 300
  }

  lifecycle {
    # The out-of-band password rotation must not be reverted by a later apply.
    ignore_changes = [master_password]
  }
}

resource "aws_rds_cluster_instance" "app" {
  identifier          = "wealthos-app-1"
  cluster_identifier  = aws_rds_cluster.app.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.app.engine
  engine_version      = aws_rds_cluster.app.engine_version
  publicly_accessible = true
}

output "aurora_endpoint" {
  description = "Aurora writer endpoint - hosted app DATABASE_URL host"
  value       = aws_rds_cluster.app.endpoint
}
