# Errors and restarts: per-hour aggregation. Output one line per hour with activity: HOUR\tERRORS\tRESTARTS.
# Reads stdin; expects start and end as awk -v vars (ISO datetime, first 19 chars compared).
# Log $1 can be longer; compare substr($1,1,19). Hour bucket = substr($1,1,13) (YYYY-MM-DDTHH).

{
    if (start != "" && end != "") {
        t = substr($1, 1, 19)
        if (t < start || t > end) next
    }

    hour = substr($1, 1, 13)

    if (index($0, "KEYMELOG|") > 0 && index($0, "async_STARTED to MANAGER") > 0) {
        restarts[hour]++
        next
    }
    if ((index($0, "<e>") > 0 || index($0, "<c>") > 0) && index($0, "KEYMELOG|") > 0) {
        errors[hour]++
    }
}

END {
    for (h in errors)
        print h "\t" errors[h] "\t" (h in restarts ? restarts[h] : 0)
    for (h in restarts)
        if (!(h in errors))
            print h "\t0\t" restarts[h]
}
