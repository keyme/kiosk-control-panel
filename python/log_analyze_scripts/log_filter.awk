# Generic log filter: -v start=, end=, pname=, log_level=, reg_message=
# Output: one line per (hour, process) with match count: HOUR\tPROCESS\tCOUNT
# Date filter uses first 19 chars of $1. Process extracted via RSTART/RLENGTH (POSIX awk).

{
    if (start != "" && end != "") {
        t = substr($1, 1, 19)
        if (t < start || t > end) next
    }

    if (pname != "") {
        if (match($0, "KEYMELOG\\|(" pname ")\\[") == 0) next
    }

    if (log_level != "" && reg_message != "") {
        if ($0 !~ log_level && $0 !~ reg_message) next
    } else {
        if (log_level != "" && $0 !~ log_level) next
        if (reg_message != "" && $0 !~ reg_message) next
    }

    hour = substr($1, 1, 13)
    if (match($0, /KEYMELOG\|[A-Z_0-9]+\[/)) {
        proc = substr($0, RSTART + 8, RLENGTH - 9)
        key = hour "\t" proc
        counts[key]++
    }
}

END {
    for (k in counts)
        print k "\t" counts[k]
}
