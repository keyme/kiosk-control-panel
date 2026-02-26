# Errors and restarts by process. Reads stdin; expects start and end as awk -v vars (ISO datetime).
# Filters lines with $1 >= start && $1 < end. Output: SUMMARY block (Error count, Restarts).

BEGIN {
    is_error_report = (is_error_report == "" ? 1 : is_error_report)
    is_restart_report = (is_restart_report == "" ? 1 : is_restart_report)

    process_string = "ABILITIES_MANAGER CONTROLLER ADVERTISER AUTOCAL BACKEND BACKGROUND_DL BROWSER " \
                     "CREDIT_CARD CUTTER DET DET_BITTING_LEFT DET_BITTING_RIGHT DET_MILLING " \
                     "DEVICE_DIRECTOR GEOMETRY GRIP_CALIB GRIPPER_CAM GUI INVENTORY INVENTORY_CAMERA " \
                     "IO JOB_SERVER ADMIN_OPTIONS KEY_PATH_GEN MOTION NETS_SERVER ORDER_DISPATCHER " \
                     "OVERHEAD_CAMERA POWER_MONITOR PRINTER RFID_READER SECURITY_CAMERA " \
                     "SECURITY_MONITOR TRANSPONDER UPLOADER"

    N = split(process_string, processes, " ")
    for (i = 1; i <= N; i++) {
        num_errs[processes[i]] = 0
        num_restarts[processes[i]] = 0
    }
}

{
    if (start != "" && end != "") {
        if ($1 < start || $1 >= end) next
    }
    if (is_error_report == 0 && is_restart_report == 0) next

    for (i = 1; i <= N; i++) {
        process = processes[i]
        if (index($0, "<e>") && index($0, "KEYMELOG|" process)) {
            num_errs[process]++
            next
        }
        if (index($0, "<c>") && index($0, "KEYMELOG|" process)) {
            num_errs[process]++
            next
        }
        if (index($0, "KEYMELOG|" process) && index($0, "async_STARTED to MANAGER")) {
            num_restarts[process]++
            break
        }
    }
}

END {
    print ""
    print "================================ SUMMARY ================================"
    if (is_error_report == 1) {
        print "Error count:"
        for (i = 1; i <= N; i++) {
            printf "    %-20s : %d\n", processes[i], num_errs[processes[i]]
        }
    }
    if (is_restart_report == 1) {
        print ""
        print "Restarts:"
        for (i = 1; i <= N; i++) {
            printf "    %-20s : %d\n", processes[i], num_restarts[processes[i]]
        }
    }
    print "================================ SUMMARY END ================================"
}
