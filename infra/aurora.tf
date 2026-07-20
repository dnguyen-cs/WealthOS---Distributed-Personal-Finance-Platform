# Aurora Serverless v2 Postgres for the hosted app - the database half of
# the $0-idle rule. min_capacity 0 auto-pauses the instance after 10
# idle minutes, so an untouched demo costs storage cents only; the
# tradeoff is a ~15s resume for the first query after a pause (accepted
# by decision, measured in MASTER.md). Engine 16.13 keeps major-version
# parity with the local postgres:16 container.
#
# Reachability: Vercel functions have no stable egress identity, so the
# instance is publicly accessible with the security group open on 5432 -
# the perimeter is TLS (rds.force_ssl below) plus the master password,
# which is rotated OUTSIDE Terraform right after the first apply
# (`aws rds modify-db-cluster --master-user-password ...`, see
# docs/DEPLOY.md) so the real secret never sits in tfstate.

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
    min_capacity             = 0   # auto-pause: $0 compute when idle
    max_capacity             = 2   # demo traffic never needs more
    seconds_until_auto_pause = 600 # 10 min: rare stalls during a demo session, still ~$0/day
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
