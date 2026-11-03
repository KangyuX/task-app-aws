# ---------------------------------------------------------------------------
# RDS: PostgreSQL holds users, tasks and attachment metadata.
# ---------------------------------------------------------------------------
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "db" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_db_instance" "db" {
  identifier                 = "${local.name}-db"
  engine                     = "postgres"
  engine_version             = "17"
  instance_class             = var.db_instance_class
  allocated_storage          = 20
  storage_type               = "gp3"
  storage_encrypted          = true
  db_name                    = "pitchin"
  username                   = "pitchin_admin"
  password                   = random_password.db.result
  db_subnet_group_name       = aws_db_subnet_group.db.name
  vpc_security_group_ids     = [aws_security_group.db.id]
  publicly_accessible        = false
  backup_retention_period    = 7
  auto_minor_version_upgrade = true
  deletion_protection        = false
  skip_final_snapshot        = true
}
