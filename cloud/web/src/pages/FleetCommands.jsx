import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Radio, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const btnPrimary =
  'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none';
const btnOutline =
  'inline-flex items-center justify-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none';
const btnDestructive =
  'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium bg-destructive text-primary-foreground hover:bg-destructive/90 disabled:opacity-50 disabled:pointer-events-none';

// Dropdown options (from plan).
const RESTART_PROCESS_OPTIONS = [
  { value: 'abilities_manager', label: 'Abilities Manager' },
  { value: 'advertiser', label: 'Advertiser' },
  { value: 'autocal', label: 'Autocal' },
  { value: 'backend', label: 'Backend' },
  { value: 'background_dl', label: 'Background Dl' },
  { value: 'browser', label: 'Browser' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'cutter', label: 'Cutter' },
  { value: 'det', label: 'Det' },
  { value: 'det_bitting_left', label: 'Det Bitting Left' },
  { value: 'det_bitting_right', label: 'Det Bitting Right' },
  { value: 'det_milling', label: 'Det Milling' },
  { value: 'device_director', label: 'Device Director' },
  { value: 'electron', label: 'Electron' },
  { value: 'finger', label: 'Finger' },
  { value: 'geometry', label: 'Geometry' },
  { value: 'gripper_cam', label: 'Gripper Cam' },
  { value: 'gui', label: 'Gui' },
  { value: 'inventory_camera', label: 'Inventory Camera' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'io', label: 'Io' },
  { value: 'key_path_gen', label: 'Key Path Gen' },
  { value: 'motion', label: 'Motion' },
  { value: 'order_dispatcher', label: 'Order Dispatcher' },
  { value: 'power_monitor', label: 'Power Monitor' },
  { value: 'rfid_reader', label: 'Rfid Reader' },
  { value: 'security_monitor', label: 'Security Monitor' },
  { value: 'security_camera', label: 'Security Camera' },
  { value: 'transponder', label: 'Transponder' },
  { value: 'uploader', label: 'Uploader' },
  { value: 'restart_all', label: 'Restart All' },
];

const RESET_DEVICE_OPTIONS = [
  { value: 'bitting_left_camera', label: 'Bitting Left Camera' },
  { value: 'bitting_right_camera', label: 'Bitting Right Camera' },
  { value: 'milling_camera', label: 'Milling Camera' },
  { value: 'gripper_camera', label: 'Gripper Camera' },
  { value: 'security_camera', label: 'Security Camera' },
  { value: 'overhead_camera', label: 'Overhead Camera' },
  { value: 'inventory_camera', label: 'Inventory Camera' },
  { value: 'modem', label: 'Modem' },
  { value: 'touchscreen_usb', label: 'Touchscreen Usb' },
  { value: 'touchscreen_power', label: 'Touchscreen Power' },
  { value: 'touchscreen_both', label: 'Touchscreen Both' },
  { value: 'all_cameras', label: 'All Cameras' },
  { value: 'rfid_reader', label: 'Rfid Reader' },
  { value: 'credit_card_reader', label: 'Credit Card Reader' },
];

const PROCESS_LIST_OPTIONS = [
  { value: 'maintenance_processes', label: 'Maintenance Processes' },
  { value: 'processes', label: 'Processes' },
  { value: 'service_processes', label: 'Service Processes' },
  { value: 'service_camera_calibration_processes', label: 'Service Camera Calibration Processes' },
  { value: 'service_scanner_verify_processes', label: 'Service Scanner Verify Processes' },
  { value: 'cmd_line_processes', label: 'Cmd Line Processes' },
  { value: 'all_but_gui', label: 'All But Gui' },
  { value: 'manufacturing', label: 'Manufacturing' },
  { value: 'magazine_processes', label: 'Magazine Processes' },
];

const selectClass = cn(
  'rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring',
  'disabled:opacity-50 disabled:pointer-events-none'
);

export default function FleetCommands({ connected, socket }) {
  const [processName, setProcessName] = useState('gui');
  const [deviceName, setDeviceName] = useState('milling_camera');
  const [processListName, setProcessListName] = useState('processes');
  const [switchReason, setSwitchReason] = useState('');

  const [confirmAction, setConfirmAction] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const isDisabled = !connected || !socket?.connected;

  function getRequestEventAndData() {
    if (!confirmAction) return null;
    switch (confirmAction.action) {
      case 'restart_process':
        return { event: 'fleet_restart_process', data: { process: processName } };
      case 'reset_device':
        return { event: 'fleet_reset_device', data: { devices: [deviceName] } };
      case 'switch_process_list':
        return {
          event: 'fleet_switch_process_list',
          data: { file: processListName, reason: switchReason || 'Fleet command' },
        };
      case 'reboot_kiosk':
        return { event: 'fleet_reboot_kiosk', data: {} };
      case 'clear_cutter_stuck':
        return { event: 'fleet_clear_cutter_stuck', data: {} };
      default:
        return null;
    }
  }

  const handleConfirm = () => {
    if (!confirmAction || !socket?.connected) return;
    const req = getRequestEventAndData();
    if (!req) return;
    setLoading(true);
    setResult(null);
    socket
      .request(req.event, req.data)
      .then((res) => {
        setLoading(false);
        setResult({
          success: res.success,
          action: confirmAction.action,
          errors: res.errors,
        });
        setConfirmAction(null);
      })
      .catch((err) => {
        setLoading(false);
        setResult({
          success: false,
          action: confirmAction.action,
          errors: [err?.message || 'Request failed'],
        });
        setConfirmAction(null);
      });
  };

  const openConfirm = (action, title, description) => {
    setResult(null);
    setConfirmAction({ action, title, description });
  };

  const processLabel = RESTART_PROCESS_OPTIONS.find((o) => o.value === processName)?.label ?? processName;
  const deviceLabel = RESET_DEVICE_OPTIONS.find((o) => o.value === deviceName)?.label ?? deviceName;
  const processListLabel = PROCESS_LIST_OPTIONS.find((o) => o.value === processListName)?.label ?? processListName;

  return (
    <div className="space-y-6">
      <PageTitle icon={Radio}>Fleet Commands</PageTitle>

      {!connected && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200" role="alert">
          Connect to a kiosk to use Fleet Commands. Select a device in the title bar.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
        {/* Restart Process */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Restart Process</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-sm">Restart a single process or all processes (e.g. GUI, Cutter).</p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                name="process_name"
                id="process_name"
                value={processName}
                onChange={(e) => setProcessName(e.target.value)}
                disabled={isDisabled}
                className={selectClass}
                aria-label="Process to restart"
              >
                {RESTART_PROCESS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <button
                type="button"
                className={btnPrimary}
                disabled={isDisabled || loading}
                onClick={() =>
                  openConfirm(
                    'restart_process',
                    'Restart process',
                    `Are you sure you want to restart "${processLabel}"?`
                  )
                }
              >
                {loading && confirmAction?.action === 'restart_process' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  'Restart'
                )}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Reset Device */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Reset Device</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-sm">Power-cycle a device (e.g. camera, modem, touchscreen).</p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                name="device_name"
                id="device_name"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                disabled={isDisabled}
                className={selectClass}
                aria-label="Device to reset"
              >
                {RESET_DEVICE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <button
                type="button"
                className={btnPrimary}
                disabled={isDisabled || loading}
                onClick={() =>
                  openConfirm(
                    'reset_device',
                    'Reset device',
                    `Are you sure you want to reset "${deviceLabel}"?`
                  )
                }
              >
                {loading && confirmAction?.action === 'reset_device' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  'Reset device'
                )}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Switch Process List */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Switch Process List</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-sm">Load a different process list (e.g. maintenance, service).</p>
            <div className="flex flex-col gap-2">
              <select
                name="process_list_name"
                id="process_list_name"
                value={processListName}
                onChange={(e) => setProcessListName(e.target.value)}
                disabled={isDisabled}
                className={selectClass}
                aria-label="Process list"
              >
                {PROCESS_LIST_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Reason (required for maintenance)"
                value={switchReason}
                onChange={(e) => setSwitchReason(e.target.value)}
                disabled={isDisabled}
                className={cn(selectClass, 'w-full')}
                aria-label="Reason for switch"
              />
              <button
                type="button"
                className={btnPrimary}
                disabled={isDisabled || loading}
                onClick={() =>
                  openConfirm(
                    'switch_process_list',
                    'Switch process list',
                    `Are you sure you want to switch to "${processListLabel}"?`
                  )
                }
              >
                {loading && confirmAction?.action === 'switch_process_list' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  'Switch process list'
                )}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Reboot Kiosk */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Reboot kiosk</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-sm">Reboot the entire kiosk. Connection will be lost.</p>
            <button
              type="button"
              className={btnDestructive}
              disabled={isDisabled || loading}
              onClick={() =>
                openConfirm(
                  'reboot_kiosk',
                  'Reboot kiosk',
                  'Are you sure you want to reboot the kiosk? The connection will be lost.'
                )
              }
            >
              {loading && confirmAction?.action === 'reboot_kiosk' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                'Reboot kiosk'
              )}
            </button>
          </CardContent>
        </Card>

        {/* Clear Cutter Stuck */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Clear cutter stuck</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-sm">Clear the cutter stuck lock (unstuck).</p>
            <button
              type="button"
              className={btnPrimary}
              disabled={isDisabled || loading}
              onClick={() =>
                openConfirm(
                  'clear_cutter_stuck',
                  'Clear cutter stuck',
                  'Are you sure you want to clear the cutter stuck state?'
                )
              }
            >
              {loading && confirmAction?.action === 'clear_cutter_stuck' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                'Clear cutter stuck'
              )}
            </button>
          </CardContent>
        </Card>
      </div>

      {/* Result popup (success or error) */}
      <Dialog open={!!result} onOpenChange={(open) => !open && setResult(null)}>
        <DialogContent showClose={true} onClose={() => setResult(null)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {result?.success ? (
                <>
                  <CheckCircle className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                  Success
                </>
              ) : (
                <>
                  <XCircle className="size-5 shrink-0 text-destructive" aria-hidden />
                  Error
                </>
              )}
            </DialogTitle>
            <DialogDescription className={result?.success ? '' : 'text-foreground'}>
              {result?.success
                ? `Command "${result.action}" completed successfully.`
                : (result?.errors && result.errors.length
                    ? result.errors.join(' ')
                    : 'Request failed.')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end pt-2">
            <button type="button" className={btnPrimary} onClick={() => setResult(null)}>
              OK
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation dialog */}
      <Dialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent showClose={true} onClose={() => setConfirmAction(null)}>
          <DialogHeader>
            <DialogTitle>{confirmAction?.title}</DialogTitle>
            <DialogDescription>{confirmAction?.description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-0">
            <button type="button" className={btnOutline} onClick={() => setConfirmAction(null)}>
              Cancel
            </button>
            <button type="button" className={btnPrimary} onClick={handleConfirm} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : 'Confirm'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
