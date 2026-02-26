# Errors and restarts: output one raw log line per event (for frontend to parse and chart).
# Reads stdin; expects start and end as awk -v vars (ISO datetime).
# Filters lines with $1 >= start && $1 < end. Prints $0 for each error or restart line.
# No process list needed: any line with KEYMELOG| is considered; process is parsed on the frontend.

{
    if (start != "" && end != "") {
        if ($1 < start || $1 >= end) next
    }

    # Restart: async_STARTED to MANAGER in a KeyMe log line
    if (index($0, "KEYMELOG|") > 0 && index($0, "async_STARTED to MANAGER") > 0) {
        print $0
        next
    }
    # Error: <e> or <c> level in a KeyMe log line
    if ((index($0, "<e>") > 0 || index($0, "<c>") > 0) && index($0, "KEYMELOG|") > 0) {
        print $0
    }
}
