# Kiosk Logging Architecture

## Log Format

Each log line looks like:

2026-02-22T14:44:16.257483-05:00 <i> ns3512 KEYMELOG|GUI[4825]: message

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


## Identifiers for log search

When answering questions about “this session” or “that scan,” the system extracts **identifiers** to locate the relevant log region:

- **session_id**: UUID (e.g. `8a6a49b0-e430-11f0-b7d2-7bf5f7dc4479`).
- **scan_id**: numeric id (e.g. `123123123`).
- **transaction_id**: numeric id for transactions (same format as scan_id).
- **testcut_id**: testcut id in grep-able form: `t` + 9 zero-padded digits (e.g. `t000015428`). Logs use this format (e.g. `"id": "t000015428"`).
e.g log line: 2025-12-29T11:12:17.040494-05:00 <i> ns3512 KEYMELOG|CUTTER[2144]: received[2LtitGeBqR]: async_REQUEST_CUT from ORDER_DISPATCHER with {"bitting": [6, 8, 6, 8, 6], "calibration_key": false, "cut_on_bad_bump": false, "disable_qc_check": true, "first_in_order": true, " gcode_path_type": "BUMPY_GCODE", "id": "t000015428", "magazine": 2, "milling": "sc19", "no_dynamic_adjust": false, "no_home_c": false, "no_reset_position": false, "pause_states": [], "profile_cut_params": {}, "s3_path": {"bucket": "keyme-calibration", "path": "testcuts/ns3512.keymekiosk.com/000/015/428/"}, "scan_type": "sc19", "skip_backstop_check": null, "style": "plain", "trash_key": false} on MainThread
- **datetime**: date and at least hour; normalized to `YYYY-MM-DDTHH` or full ISO (e.g. `2025-12-28T17:21:16`).

These are passed to the device as a list; the first match in the log (session, scan, transaction, or timestamp) is used to fetch the surrounding lines for analysis.

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

## What is given to this model
 - Most of the time, you are given limited context: typically about 200 lines before (–B200) and up to 20,000 lines after (–A20000) a known anchor point or identifier. If a user asks about information that is not included in this context, let them know and advise them to start a new session with the appropriate identifiers.

 - Also, almost always you are given part of all.log in /var/log/keyme/all.log

## When responding to questions
 - Do not reference log lines e.g "[all.log:1037]" because the user won't have access to this log and in the device thoese lines numbers would be different. Instead, reference timestamps in the logs instead.

 - If a question is asked about a specific session_id, scan_id, transaction_id, or testcut_id, try to reconstruct the user's chronological flow through the system. Most user interactions are logged by the GUI (which typically creates events for important user and system actions). And other important processes in the example E.g.:
    - [datetime] GUI: started new session
    - [datetime] User: scanned a key
    - [datetime] DET_BITTING_LEFT: key present detected
    - [datetime] DET_BITTING_RIGHT: key present detected
    - [datetime] DET: scan successful: type of key, etc.
    - [datetime] GUI: payment requested
    - [datetime] CREDIT_CARD: payment successful/failed (reason why failed if any)
    - [datetime] CUTTER: Cut requested
    - [datetime] CUTTER: cut successful/failed
    - [datetime] GRIPPER_CAM: key analysis (Error in bit (EIB), etc.)
    - [datetime] key dropped

  this is just a example you are welcome to improve and add more events as needed.
