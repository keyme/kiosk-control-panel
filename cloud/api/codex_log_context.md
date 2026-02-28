# Kiosk Logging Architecture

## Log Format

Each log line looks like:

2026-02-22T14:44:16.257483-05:00 <i> ns3512 KEYMELOG|CONTROL_PANEL[4825]: message

Structure:
- ISO8601 timestamp
- Log level in angle brackets:
  - <d> debug
  - <i> info
  - <w> warning
  - <e> error
- Hostname (e.g., ns3512)
- Tag: KEYMELOG|PROCESS_NAME[PID] — identifies process and PID.
- Body: everything after the first colon.

## Log Storage

The log file to analyze is specified in each request (passed in the prompt). Logs are sequential; processes communicate over IPC and those messages appear in the log as well.

## pname

pname corresponds to:
- GUI
- DET
- CUTTER
- INVENTORY
- etc.
You can find entire list in: ./manager/config/master_process_list.json

You can also see which process running which module. e.g. GUI code lives in: ./gui5  etc. If
you are not clear about some log message, you can check the code in the corresponding module to understand what it is doing.


## Where logs come from (application side)
 - Python: pylib/log.py. Processes call keyme.log.info(), keyme.log.warning(), keyme.log.error(), keyme.log.debug(), etc.
 - Logger opens syslog with tag KEYMELOG|ProcessName (or KEYMELOG|ProcessName|suffix if process_suffix is set). Messages go to syslog (LOG_USER).
 - Debug: Only written to the per-process log file; rsyslog is configured so debug does not go to all.log (see logs.conf "disable debug messages in the main log").
 - Critical (e.g. uncaught exceptions): log.exception() uses LOG_CRIT; appears as <c> in the log.
