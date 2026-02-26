# Errors and restarts: per-hour per-process aggregation.
# Output one line per (hour, process) with activity: HOUR\tPROCESS\tERRORS\tRESTARTS.
# Reads stdin; expects start and end as awk -v vars. Hour bucket = substr($1,1,13) (YYYY-MM-DDTHH).

BEGIN {
    process_string = "ABILITIES_MANAGER CONTROLLER ADVERTISER AUTOCAL BACKEND BACKGROUND_DL BROWSER " \
                     "CREDIT_CARD CUTTER DET DET_BITTING_LEFT DET_BITTING_RIGHT DET_MILLING " \
                     "DEVICE_DIRECTOR GEOMETRY GRIP_CALIB GRIPPER_CAM GUI INVENTORY INVENTORY_CAMERA " \
                     "IO JOB_SERVER ADMIN_OPTIONS KEY_PATH_GEN MOTION NETS_SERVER ORDER_DISPATCHER " \
                     "OVERHEAD_CAMERA POWER_MONITOR PRINTER RFID_READER SECURITY_CAMERA " \
                     "SECURITY_MONITOR TRANSPONDER UPLOADER CONTROL_PANEL"
    N = split(process_string, processes, " ")
}

{
    if (start != "" && end != "") {
        t = substr($1, 1, 19)
        if (t < start || t > end) next
    }

    hour = substr($1, 1, 13)

    if (index($0, "KEYMELOG|") > 0 && index($0, "async_STARTED to MANAGER") > 0) {
        for (i = 1; i <= N; i++) {
            p = processes[i]
            if (index($0, "KEYMELOG|" p "[") > 0) {
                key = hour "\t" p
                restarts[key]++
                break
            }
        }
        next
    }
    if ((index($0, "<e>") > 0 || index($0, "<c>") > 0) && index($0, "KEYMELOG|") > 0) {
        for (i = 1; i <= N; i++) {
            p = processes[i]
            if (index($0, "KEYMELOG|" p "[") > 0) {
                key = hour "\t" p
                errors[key]++
                break
            }
        }
    }
}

END {
    for (k in errors)
        print k "\t" errors[k] "\t" (k in restarts ? restarts[k] : 0)
    for (k in restarts)
        if (!(k in errors))
            print k "\t0\t" restarts[k]
}
