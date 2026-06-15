#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Login to WTS AWS SSO
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon ./images/wedbush.png

# Documentation:
# @raycast.description WTS AWS SSO Login
# @raycast.author Prithwee Das
# @raycast.authorURL https://github.com/prithweedas

aws sso login --sso-session wts-sso

