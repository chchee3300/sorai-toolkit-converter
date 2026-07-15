#!/bin/sh
# NL_PATH (used to resolve binaries/<platform>/ffmpeg) is the directory
# containing the running executable -- cd there first so it resolves
# correctly regardless of how this launcher itself was invoked.
cd /opt/sorai-toolkit || exit 1
exec ./sorai-toolkit "$@"
