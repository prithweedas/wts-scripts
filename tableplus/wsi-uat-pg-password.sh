#!/bin/bash

# Check if Azure CLI is installed
if ! command -v az &> /dev/null
then
    echo "Azure CLI (az) is not installed. Please install it first."
    exit 1
fi

# Get the access token
TOKEN=$(az account get-access-token --query accessToken --output tsv)

# Output the token only
echo $TOKEN