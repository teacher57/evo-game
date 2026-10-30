#!/bin/zsh
# Evo game server on this Mac: ./mac.sh start | stop | status
# Listens only on 127.0.0.1:8787 (this Mac), keeps running after the terminal closes,
# and resumes the saved run from state.json. Watch it with: open ../watch.html
cd "${0:A:h}"
PIDFILE=server.pid
running() { [[ -f $PIDFILE ]] && kill -0 $(<$PIDFILE) 2>/dev/null }

case $1 in
  start)
    if running; then echo "already running (pid $(<$PIDFILE))"; exit 0; fi
    nohup node server.js 8787 127.0.0.1 >> server.log 2>&1 &
    echo $! > $PIDFILE
    sleep 1
    running && echo "started (pid $(<$PIDFILE)), log: server/server.log" || { echo "failed, see server/server.log"; exit 1; }
    ;;
  stop)
    if running; then kill $(<$PIDFILE); rm -f $PIDFILE; echo "stopped (the run was saved, start continues it)"
    else rm -f $PIDFILE; echo "not running"; fi
    ;;
  status)
    if running; then echo "running (pid $(<$PIDFILE))"; curl -s --max-time 3 http://127.0.0.1:8787/; echo
    else echo "not running"; fi
    ;;
  *) echo "usage: ./mac.sh start | stop | status"; exit 1 ;;
esac
