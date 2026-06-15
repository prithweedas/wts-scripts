#!/usr/bin/env bash
AWS_CLI="/opt/homebrew/bin/aws"

if ! command -v $AWS_CLI &> /dev/null
then
  echo "Error: AWS CLI not found or not executable at $AWS_CLI."
  exit 1
fi

PROFILE="wts-staging"

PASSWORD=$($AWS_CLI ssm get-parameter --name "/wb/staging/integration-layer/db-password" --with-decryption --query "Parameter.Value" --output text --profile $PROFILE | tr -d "\n")

echo -n $PASSWORD