# Generic log filter: -v start=, end=, pname=, log_level=, reg_message=, combine=
# combine=AND_OR (default): process must match if set; level OR message if set (process AND (level OR message)).
# combine=OR: line matches if at least one of pname/log_level/reg_message matches.
# combine=AND: line must match every set filter (pname, log_level, reg_message).
# Output: one line per (hour, process) with match count: HOUR\tPROCESS\tCOUNT
# Date filter uses first 19 chars of $1. Process extracted via RSTART/RLENGTH (POSIX awk).

{
    if (start != "" && end != "") {
        t = substr($1, 1, 19)
        if (t < start || t > end) next
    }

    if (combine == "AND") {
        if (pname != "" && match($0, "KEYMELOG\\|(" pname ")\\[") == 0) next
        if (log_level != "" && $0 !~ log_level) next
        if (reg_message != "" && $0 !~ reg_message) next
    } else if (combine == "AND_OR") {
        if (pname != "" && match($0, "KEYMELOG\\|(" pname ")\\[") == 0) next
        if (log_level != "" && reg_message != "") {
            if ($0 !~ log_level && $0 !~ reg_message) next
        } else {
            if (log_level != "" && $0 !~ log_level) next
            if (reg_message != "" && $0 !~ reg_message) next
        }
    } else {
        # OR or default: match if at least one set clause matches; if all empty, match all
        if (pname != "" || log_level != "" || reg_message != "") {
            matched = (pname != "" && match($0, "KEYMELOG\\|(" pname ")\\[") != 0) || \
                      (log_level != "" && $0 ~ log_level) || \
                      (reg_message != "" && $0 ~ reg_message)
            if (!matched) next
        }
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
