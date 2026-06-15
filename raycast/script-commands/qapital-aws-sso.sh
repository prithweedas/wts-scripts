#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Login to Qapital AWS SSO
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon ./images/qapital.png

# Documentation:
# @raycast.description Qapital AWS SSO Login
# @raycast.author Prithwee Das
# @raycast.authorURL https://github.com/prithweedas

aws sso login --sso-session qapital-sso

