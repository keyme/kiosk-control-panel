import { useState, Fragment } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import {
  Activity,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cpu,
  Gauge,
  Link2,
  MemoryStick,
  Clock,
  Thermometer,
  Monitor,
  Search,
  Server,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Dummy data – replace with backend later
const PC_STATS_DUMMY = {
  cpu_percent: 11,
  memory_percent: 62,
  uptime: '2 days, 21 hours, 59 mins',
  cpu_temp: '42 °C (Hi/Lo: 43/37 °C)',
  os_version: 'v7.25.80 FR1 (Fri Aug 8 17:13:56 UTC 2025)',
  load_average: '0.52, 0.48, 0.45',
  time_updated: 'Thu Jan 29 2026 14:46:19 GMT-0500 (Eastern Standard Time)',
};

// Kiosk Stats: wtf, why_degraded (command outputs), processes (keystat), time_updated. Replace with backend.
const KIOSK_STATS_DUMMY = {
  wtf: 'degraded abilities: extra_processes_running, uploader_running',
  why_degraded: `{   'extra_processes_running': [   'processes.ABILITIES_MANAGER.extra_processes_running'],
    'uploader_running': ['processes.MANAGER.processes.UPLOADER.running']}`,
  time_updated: 'Thu Jan 29 2026 14:58:14 GMT-0500 (Eastern Standard Time)',
  processes: [
    { name: 'KIOSK:MANAGER', pid: 8149, cpu: 3, runtime: '00:10:12', user: 'kiosk' },
    { name: 'KIOSK:ABILITIES_MANAGER', pid: 14810, cpu: 0, runtime: '00:01:54', user: 'kiosk' },
    { name: 'KIOSK:AUTOCAL', pid: 16248, cpu: 0, runtime: '00:01:32', user: 'kiosk' },
    { name: 'KIOSK:BACKEND', pid: 14811, cpu: 0, runtime: '00:00:18', user: 'kiosk' },
    { name: 'KIOSK:DET_BITTING_LEFT', pid: 15301, cpu: 81, runtime: '04:07:21', user: 'kiosk' },
    { name: 'KIOSK:DET_MILLING', pid: 15294, cpu: 0, runtime: '00:00:43', user: 'kiosk' },
    { name: 'KIOSK:MOTION', pid: 15281, cpu: 1, runtime: '00:05:39', user: 'kiosk' },
    { name: 'KIOSK:GUI', pid: 17061, cpu: 0, runtime: '00:00:41', user: 'kiosk' },
    { name: 'KIOSK:CONTROL_PANEL', pid: 14847, cpu: 0, runtime: '00:00:05', user: 'kiosk' },
    { name: 'KIOSK:UPLOADER', pid: 1759, cpu: 5, runtime: '00:00:00', user: 'kiosk' },
    { name: 'KIOSK:SYSTEM_MONITOR', pid: 7295, cpu: 1, runtime: '00:06:06', user: 'root' },
  ],
};

// Full status (abilities, devices, processes) – subset for Cameras, Devices, Problems, Motion. Replace with backend.
const STATUS_DUMMY = {
  abilities: {
    bitting_left_camera_connected: true,
    bitting_left_no_frames: false,
    bitting_left_ready_to_scan: true,
    bitting_right_camera_connected: true,
    bitting_right_no_frames: false,
    bitting_right_ready_to_scan: true,
    milling_camera_connected: true,
    milling_no_frames: false,
    milling_ready: true,
    gripper_camera_connected: true,
    gripper_no_frames: false,
    gripper_camera_ready: true,
    gripper_camera_critical: false,
    inventory_camera_connected: true,
    inventory_no_frames: false,
    inventory_camera_ready: true,
    security_camera_connected: true,
    security_no_frames: false,
    security_camera_ready: true,
    minor_cameras_critical: false,
    X_calibrated: false,
    Y_calibrated: false,
    Z_calibrated: false,
    C_calibrated: false,
    pci_buses_present: false,
    pci_cards_working: false,
    screen_settings_correct: false,
    gui_app_mounted: false,
    symlinks_correct: false,
  },
  devices: {
    ARDUINO: { available: false },
    BITTING_LEFT_CAMERA: { available: true },
    BITTING_RIGHT_CAMERA: { available: true },
    CREDIT_CARD_READER: { available: true },
    GRIPPER_CAMERA: { available: true },
    INVENTORY_CAMERA: { available: true },
    MILLING_CAMERA: { available: true },
    OVERHEAD_CAMERA: { available: true },
    RFID_READER: { available: true },
    SECURITY_CAMERA: { available: true },
    TOUCHSCREEN: { available: true },
    TRANSPONDER_READER: { available: true },
    UPS: { available: false },
    WIRELESS_KEYBOARD: { available: false },
  },
  processes: {
    DET_BITTING_LEFT: { bitting_persistent_loop_running: true, good_homography: true, nets_loaded: true, no_frames: false, ready_to_scan: true },
    DET_BITTING_RIGHT: { bitting_persistent_loop_running: true, good_homography: true, nets_loaded: true, no_frames: false, ready_to_scan: true },
    DET_MILLING: { camera_ready: true, milling_nets_loaded: true, no_frames: false, milling_persistent_loop_running: true },
    GRIPPER_CAM: { camera_ready: true, gripper_persistent_loop_running: true, no_frames: false },
    INVENTORY_CAMERA: { camera_ready: true, inventory_camera_persistent_loop_running: true, no_frames: false },
    SECURITY_CAMERA: { camera_ready: true, security_persistent_loop_running: true, no_frames: false },
    MOTION: { X_calibrated: false, Y_calibrated: false, Z_calibrated: false, C_calibrated: false, hardware_online: true },
  },
  time_updated: {
    cameras: 'Thu Jan 29 2026 15:02:11 GMT-0500 (Eastern Standard Time)',
    devices: 'Thu Jan 29 2026 15:02:09 GMT-0500 (Eastern Standard Time)',
    motion: 'Thu Jan 29 2026 15:02:13 GMT-0500 (Eastern Standard Time)',
    problems: 'Thu Jan 29 2026 15:02:10 GMT-0500 (Eastern Standard Time)',
  },
};

const CAMERAS = [
  { id: 'bitting_left', label: 'Bitting Left', connected: 'bitting_left_camera_connected', noFrames: 'bitting_left_no_frames', ready: 'bitting_left_ready_to_scan', critical: null, processKey: 'DET_BITTING_LEFT' },
  { id: 'bitting_right', label: 'Bitting Right', connected: 'bitting_right_camera_connected', noFrames: 'bitting_right_no_frames', ready: 'bitting_right_ready_to_scan', critical: null, processKey: 'DET_BITTING_RIGHT' },
  { id: 'milling', label: 'Milling', connected: 'milling_camera_connected', noFrames: 'milling_no_frames', ready: 'milling_ready', critical: null, processKey: 'DET_MILLING' },
  { id: 'gripper', label: 'Gripper', connected: 'gripper_camera_connected', noFrames: 'gripper_no_frames', ready: 'gripper_camera_ready', critical: 'gripper_camera_critical', processKey: 'GRIPPER_CAM' },
  { id: 'inventory', label: 'Inventory', connected: 'inventory_camera_connected', noFrames: 'inventory_no_frames', ready: 'inventory_camera_ready', critical: null, processKey: 'INVENTORY_CAMERA' },
  { id: 'security', label: 'Security', connected: 'security_camera_connected', noFrames: 'security_no_frames', ready: 'security_camera_ready', critical: null, processKey: 'SECURITY_CAMERA' },
];

const PROCESS_VISIBLE_INITIAL = 7;

const DEVICE_ORDER = ['ARDUINO', 'BITTING_LEFT_CAMERA', 'BITTING_RIGHT_CAMERA', 'CREDIT_CARD_READER', 'GRIPPER_CAMERA', 'INVENTORY_CAMERA', 'MILLING_CAMERA', 'OVERHEAD_CAMERA', 'RFID_READER', 'SECURITY_CAMERA', 'TOUCHSCREEN', 'TRANSPONDER_READER', 'UPS', 'WIRELESS_KEYBOARD'];

// Terminals / SSH – dummy data, backend later
const TERMINALS_DUMMY = {
  remote_users: ['alice', 'bob'],
  local_count: 1,
  time_updated: null,
};

function getVal(obj, key) {
  return obj != null && typeof obj === 'object' && key in obj ? obj[key] : undefined;
}

function StatItem({ icon: Icon, label, value, className }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 text-sm',
        className
      )}
    >
      <Icon
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0">
        {label ? (
          <>
            <span className="text-muted-foreground">{label}: </span>
            <span className="text-foreground">{value ?? '—'}</span>
          </>
        ) : (
          <span className="text-foreground">{value ?? '—'}</span>
        )}
      </div>
    </div>
  );
}

/** Parse why-degraded output (Python dict-like) into an object. Falls back to null on failure. */
function parseWhyDegraded(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const json = s
      .replace(/\bNone\b/g, 'null')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/'/g, '"');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function _stdout(v) {
  return typeof v === 'string' ? v : (v && typeof v.stdout === 'string' ? v.stdout : null);
}
function _stderr(v) {
  return v && typeof v.stderr === 'string' && v.stderr.trim() ? v.stderr.trim() : null;
}

function WtfWhyDegraded({ wtf, whyDegraded }) {
  const wtfOut = _stdout(wtf);
  const wtfErr = _stderr(wtf);
  const whyOut = _stdout(whyDegraded);
  const whyErr = _stderr(whyDegraded);
  const parsed = parseWhyDegraded(whyOut);
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap gap-x-1.5">
          <span className="text-muted-foreground" title="Short list of which abilities are currently degraded (comma-separated names).">wtf:</span>
          <span className="text-foreground">{wtfOut ?? '—'}</span>
        </div>
        {wtfErr && (
          <pre className="m-0 whitespace-pre-wrap break-words text-destructive/90 text-xs">
            {wtfErr}
          </pre>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground" title="For each degraded ability, the reason or details (e.g. which process or condition causes it).">why-degraded:</span>
        {parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (
          <div className="flex flex-col gap-1.5 text-foreground">
            {Object.entries(parsed).map(([key, val]) => (
              <div key={key} className="flex flex-col gap-0.5 pl-2 border-l-2 border-border">
                <span className="font-medium text-muted-foreground">{key}</span>
                {Array.isArray(val) ? (
                  <ul className="m-0 list-inside list-disc pl-1 text-foreground">
                    {val.map((item, i) => (
                      <li key={i}>{String(item)}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-foreground">{String(val)}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <pre className="m-0 whitespace-pre-wrap break-words text-foreground">
            {whyOut ?? '—'}
          </pre>
        )}
        {whyErr && (
          <pre className="m-0 mt-1 whitespace-pre-wrap break-words text-destructive/90 text-xs">
            {whyErr}
          </pre>
        )}
      </div>
    </div>
  );
}

function TimeUpdatedFooter({ timeUpdated, className }) {
  return (
    <div
      className={cn(
        'mt-4 flex flex-wrap gap-x-1.5 border-t border-border pt-2 text-sm text-muted-foreground',
        className
      )}
    >
      <span>Time updated:</span>
      <span className="text-foreground">{timeUpdated ?? '—'}</span>
    </div>
  );
}

function CamerasMatrix({ status }) {
  const [expanded, setExpanded] = useState(null);
  const a = status?.abilities ?? {};
  const procs = status?.processes ?? {};

  return (
    <Card id="section-cameras">
      <CardHeader>
        <CardTitle className="flex items-center gap-2" title="Status of kiosk cameras (bitting, milling, gripper, inventory, security, etc.): connection, whether frames are received, and ready state from the abilities manager.">
          <Camera className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          Cameras
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-w-3xl overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="w-8 px-2 py-1" aria-label="Expand" />
                <th className="px-2 py-1 text-left font-medium text-muted-foreground">Camera</th>
                <th className="px-2 py-1 text-center font-medium text-muted-foreground">Connected</th>
                <th className="px-2 py-1 text-center font-medium text-muted-foreground">Frames</th>
                <th className="px-2 py-1 text-center font-medium text-muted-foreground">Ready</th>
                <th className="px-2 py-1 text-center font-medium text-muted-foreground">Not critical</th>
              </tr>
            </thead>
            <tbody>
              {CAMERAS.map((cam) => {
                const connected = !!getVal(a, cam.connected);
                const noFrames = !!getVal(a, cam.noFrames);
                const ready = !!getVal(a, cam.ready);
                const critical = cam.critical ? !!getVal(a, cam.critical) : false;
                const hasFrames = !noFrames;
                const bad = noFrames || !ready || critical;
                const raw = getVal(procs, cam.processKey);
                const isExpanded = expanded === cam.id;
                return (
                  <Fragment key={cam.id}>
                    <tr
                      className={cn(
                        'border-b border-border hover:bg-muted/30',
                        bad && 'bg-destructive/10'
                      )}
                    >
                      <td className="w-8 px-2 py-1">
                        {raw != null && typeof raw === 'object' ? (
                          <button
                            type="button"
                            onClick={() => setExpanded(isExpanded ? null : cam.id)}
                            className="text-muted-foreground hover:text-foreground"
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? 'Collapse raw fields' : 'Expand raw fields'}
                          >
                            {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          </button>
                        ) : (
                          <span className="inline-block w-4" />
                        )}
                      </td>
                      <td className="px-2 py-1 font-medium">{cam.label}</td>
                      <td className="px-2 py-1 text-center">{connected ? <Check className="text-emerald-500 inline-block size-4" /> : <X className="text-destructive inline-block size-4" />}</td>
                      <td className="px-2 py-1 text-center">{hasFrames ? <Check className="text-emerald-500 inline-block size-4" /> : <X className="text-destructive inline-block size-4" />}</td>
                      <td className="px-2 py-1 text-center">{ready ? <Check className="text-emerald-500 inline-block size-4" /> : <X className="text-destructive inline-block size-4" />}</td>
                      <td className="px-2 py-1 text-center">{critical ? <X className="text-destructive inline-block size-4" /> : <Check className="text-emerald-500 inline-block size-4" />}</td>
                    </tr>
                    {isExpanded && raw != null && (
                      <tr className="border-b border-border bg-muted/20">
                        <td colSpan={6} className="px-2 py-1">
                          <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-xs">
                            {JSON.stringify(raw, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <TimeUpdatedFooter timeUpdated={status?.time_updated?.cameras} />
      </CardContent>
    </Card>
  );
}

function DevicesGrid({ status }) {
  const devs = status?.devices ?? {};
  return (
    <Card id="section-devices">
      <CardHeader>
        <CardTitle className="flex items-center gap-2" title="Hardware devices reported by the kiosk (e.g. readers, printers): whether each device is currently available.">
          <Wrench className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          Devices
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-w-3xl overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-2 py-1 text-left font-medium text-muted-foreground">Device</th>
                <th className="px-2 py-1 text-center font-medium text-muted-foreground">Available</th>
              </tr>
            </thead>
            <tbody>
              {DEVICE_ORDER.filter((k) => k in devs).map((key) => {
                const avail = !!getVal(getVal(devs, key), 'available');
                return (
                  <tr key={key} className="border-b border-border last:border-b-0 hover:bg-muted/30">
                    <td className="px-2 py-1 font-medium">{key.replace(/_/g, ' ')}</td>
                    <td className="px-2 py-1 text-center">{avail ? <Check className="text-emerald-500 inline-block size-4" /> : <X className="text-destructive inline-block size-4" />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <TimeUpdatedFooter timeUpdated={status?.time_updated?.devices} />
      </CardContent>
    </Card>
  );
}

function StatusDot({ active }) {
  return (
    <span
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        active ? 'bg-emerald-500' : 'bg-muted'
      )}
      aria-hidden
    />
  );
}

function TerminalsBlock({ terminals: terminalsProp }) {
  const t = terminalsProp ?? TERMINALS_DUMMY;
  const remoteUsers = t.remote_users ?? [];
  const remoteCount = t.remote_count ?? remoteUsers.length;
  const localCount = t.local_count ?? 0;

  return (
    <div id="section-terminals" className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
      <div>
        <Terminal className="inline-block size-4 shrink-0 align-middle text-muted-foreground" aria-hidden />
        {' '}
        <span className="font-medium text-muted-foreground">Remote (SSH)</span>
        {' '}
        <span className="inline-flex items-center gap-0.5 align-middle" aria-hidden>
          {Array.from({ length: Math.max(remoteCount, 1) }).map((_, i) => (
            <StatusDot key={i} active={i < remoteCount} />
          ))}
        </span>
        {' '}
        <span className="tabular-nums">{remoteCount} user{remoteCount !== 1 ? 's' : ''}</span>
        {remoteCount > 0 && (
          <span className="text-muted-foreground"> — {remoteUsers.join(', ')}</span>
        )}
      </div>
      <div>
        <span className="font-medium text-muted-foreground">Local</span>
        {' '}
        <span className="inline-flex items-center gap-0.5 align-middle" aria-hidden>
          {Array.from({ length: Math.max(localCount, 1) }).map((_, i) => (
            <StatusDot key={i} active={i < localCount} />
          ))}
        </span>
        {' '}
        <span className="tabular-nums">{localCount} terminal{localCount !== 1 ? 's' : ''}</span>
      </div>
    </div>
  );
}

function formatCpuMem(v) {
  return v != null && typeof v === 'number' ? `${v}%` : '—';
}

export default function Status({ connected, computerStats, wtfWhyDegraded, status: statusProp, terminals, connectionCount }) {
  const s = computerStats ?? PC_STATS_DUMMY;
  const k = KIOSK_STATS_DUMMY;
  const w = wtfWhyDegraded;
  const status = statusProp ?? STATUS_DUMMY;
  const isDummyData = !connected;
  const [processExpanded, setProcessExpanded] = useState(false);
  const [processSearch, setProcessSearch] = useState('');

  const processes = (w?.processes ?? k.processes) ?? [];
  const sorted = [...processes].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0));
  const q = processSearch.trim().toLowerCase();
  const filtered = q
    ? sorted.filter((p) => (p.name || '').toLowerCase().includes(q))
    : sorted;
  const visible = processExpanded ? filtered : filtered.slice(0, PROCESS_VISIBLE_INITIAL);
  const hasMore = filtered.length > PROCESS_VISIBLE_INITIAL;

  return (
    <div className="space-y-6">
      <PageTitle icon={Activity}>Status</PageTitle>

      {isDummyData && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200" role="alert">
          <strong>No connection to the kiosk.</strong> The data below is placeholder/dummy data and does not reflect the real kiosk.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Computer</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            <StatItem icon={Cpu} label="CPU" value={formatCpuMem(s.cpu_percent)} />
            <StatItem icon={MemoryStick} label="Memory" value={formatCpuMem(s.memory_percent)} />
            <StatItem icon={Clock} label="Uptime" value={s.uptime || '—'} />
            <StatItem icon={Thermometer} label="CPU temp" value={s.cpu_temp || '—'} />
            <StatItem icon={Gauge} label="Load average" value={s.load_average || '—'} />
            <StatItem icon={Monitor} label="OS version" value={s.os_version || '—'} />
            <StatItem icon={Link2} label="WebSocket connections" value={connectionCount != null ? String(connectionCount) : '—'} />
          </div>
          <TerminalsBlock terminals={terminals} />
          <TimeUpdatedFooter timeUpdated={s.time_updated || null} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            Kiosk Stats
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <WtfWhyDegraded
            wtf={w?.wtf ?? k.wtf}
            whyDegraded={w?.why_degraded ?? k.why_degraded}
          />
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[160px] max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  type="search"
                  placeholder="Filter by name…"
                  value={processSearch}
                  onChange={(e) => setProcessSearch(e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Filter processes by name"
                />
              </div>
              {hasMore && (
                <button
                  type="button"
                  onClick={() => setProcessExpanded((e) => !e)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {processExpanded ? (
                    <>
                      <ChevronUp className="size-3.5" aria-hidden />
                      Show top {PROCESS_VISIBLE_INITIAL}
                    </>
                  ) : (
                    <>
                      <ChevronDown className="size-3.5" aria-hidden />
                      Show all ({filtered.length})
                    </>
                  )}
                </button>
              )}
            </div>
            <div className="max-w-3xl overflow-x-auto rounded-md border border-border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-2 py-1 text-left font-medium text-muted-foreground">Process</th>
                    <th className="px-2 py-1 text-right font-medium text-muted-foreground">PID</th>
                    <th className="px-2 py-1 text-right font-medium text-muted-foreground">CPU %</th>
                    <th className="px-2 py-1 text-right font-medium text-muted-foreground">Runtime</th>
                    <th className="hidden px-2 py-1 text-left font-medium text-muted-foreground sm:table-cell">User</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-2 py-3 text-center text-muted-foreground">
                        {q ? 'No processes match the filter.' : 'No processes.'}
                      </td>
                    </tr>
                  ) : (
                    visible.map((proc) => (
                      <tr key={proc.pid} className="border-b border-border last:border-b-0 hover:bg-muted/30">
                        <td className="px-2 py-1 font-medium">{proc.name}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{proc.pid}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{proc.cpu}%</td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{proc.runtime}</td>
                        <td className="hidden px-2 py-1 text-muted-foreground sm:table-cell">{proc.user}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <TimeUpdatedFooter timeUpdated={w?.time_updated ?? k.time_updated} />
        </CardContent>
      </Card>

      <CamerasMatrix status={status} />
      <DevicesGrid status={status} />
      </div>
    </div>
  );
}
