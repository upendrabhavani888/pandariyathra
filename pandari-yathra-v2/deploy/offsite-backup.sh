#!/bin/sh
# Copies the newest nightly database copy, plus the Govt ID key, to another machine, so one broken server does not lose everything.
# Edit DEST, then run it from cron, for example nightly at 03:30:   30 3 * * * /opt/pandari-yathra/deploy/offsite-backup.sh
# (Not tested on your machines: try it by hand first.)
set -eu
DATA_DIR="${DATA_DIR:-/var/lib/pandari-yathra}"
DEST="${DEST:-backupuser@other-machine.example.org:/backups/pandari-yathra/}"
NEWEST="$(ls -1 "$DATA_DIR"/backups/yatra-*.db | tail -n 1)"
scp -q "$NEWEST" "$DEST"
# The key that unlocks Govt ID numbers. If you set ID_ENC_KEY in the env file, keep that value safe instead.
[ -f "$DATA_DIR/.enckey" ] && scp -q "$DATA_DIR/.enckey" "$DEST"
echo "Copied $NEWEST to $DEST"
