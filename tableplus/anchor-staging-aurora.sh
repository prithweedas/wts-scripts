#!/usr/bin/env bash
AWS_CLI="/opt/homebrew/bin/aws"

if ! command -v $AWS_CLI &> /dev/null
then
  echo "Error: AWS CLI not found or not executable at $AWS_CLI."
  exit 1
fi

USER="prithwee.das@wedbush.tech-wr"
PORT="5432"
HOST="wts-staging-anchor-aurora.cluster-c9ocw8mg2p45.us-east-1.rds.amazonaws.com"
PROFILE="wts-staging-rds"

PGPASSWORD=$($AWS_CLI rds generate-db-auth-token --profile $PROFILE --hostname $HOST --port $PORT --region us-east-1 --username $USER | tr -d "\n")

echo -n $PGPASSWORD