import { createContext, useContext, useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useNavigate, useLocation, Outlet } from 'react-router-dom';
import {
  Gauge,
  Activity,
  Tag,
  Layers,
  Flag,
  CheckCircle,
  Link as LinkIcon,
  Terminal,
  LogOut,
} from 'lucide-react';
import { lazy, Suspense } from 'react';
import Status from '@/pages/Status';
import Calibration, { CalibrationIndexRedirect, CalibrationTracingIndexRedirect } from '@/pages/Calibration';
import CalibrationLatestRedirect from '@/pages/CalibrationLatestRedirect';
import CalibrationReport from '@/pages/CalibrationReport';
import CalibrationReportSection from '@/pages/CalibrationReportSection';
import CalibrationTracingGripperCam from '@/pages/CalibrationTracingGripperCam';
import CalibrationTracingLatestRedirect from '@/pages/CalibrationTracingLatestRedirect';
import CameraImagesPage from '@/pages/CameraImagesPage';
import ConfigPage from '@/pages/ConfigPage';
import WellnessCheck from '@/pages/WellnessCheck';
import DataUsage from '@/pages/DataUsage';
import FleetCommands from '@/pages/FleetCommands';
import LogTailPage from '@/pages/LogTailPage';

const TestcutsImagesPage = lazy(() => import('@/pages/TestcutsImagesPage'));
const BittingCalibrationImagesPage = lazy(() => import('@/pages/BittingCalibrationImagesPage'));
const RunBasedCalibrationImagesPage = lazy(() => import('@/pages/RunBasedCalibrationImagesPage'));
import { AppSidebar } from '@/components/AppSidebar';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { buildWsUrl, createDeviceSocket } from '@/lib/deviceSocket';
import { getInitialDeviceHost } from '@/lib/socketUrl';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { getToken, apiFetch } from '@/lib/apiFetch';
import LoginPage from '@/pages/LoginPage';

const DeviceHostContext = createContext({ deviceHost: '', setDeviceHost: () => {} });

function KioskSync() {
  const { kiosk } = useParams();
  const { setDeviceHost } = useContext(DeviceHostContext);
  useEffect(() => {
    if (kiosk) setDeviceHost(kiosk);
  }, [kiosk, setDeviceHost]);
  return <Outlet />;
}

/** Wraps a page so it receives kioskName from the :kiosk route param. */
function WrapKiosk({ component: Component, ...rest }) {
  const { kiosk } = useParams();
  return <Component kioskName={kiosk ?? ''} {...rest} />;
}

const ACTIVITY_LABELS = { inactive: 'Inactive', active: 'Active', service: 'Service Mode' };

function statusDotVariant(state) {
  if (state === 'ALL_SYSTEMS_GO') return 'ok';
  if (state === 'DEGRADED') return 'error';
  return 'warn';
}

function StatusDot({ variant }) {
  const dotClass = {
    ok: 'bg-emerald-500',
    warn: 'bg-amber-500',
    error: 'bg-destructive',
    muted: 'bg-muted-foreground',
  }[variant || 'muted'];
  return (
    <span
      className={cn('size-2 shrink-0 rounded-full', dotClass)}
      aria-hidden
    />
  );
}

function TitleItem({ icon: Icon, label, children, className, title, ...rest }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-[0.9375rem]',
        className
      )}
      title={title}
      {...rest}
    >
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      {label && <span className="text-muted-foreground">{label}</span>}
      {children}
    </span>
  );
}

function Layout({ kioskName, connected, lastError, connectionRejected, disconnectedDueToInactivity, panelInfo, terminals, children }) {
  const { deviceHost, setDeviceHost } = useContext(DeviceHostContext);
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [editValue, setEditValue] = useState(deviceHost);
  const deviceHostInputRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'u') {
        e.preventDefault();
        deviceHostInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useLayoutEffect(() => {
    document.title = kioskName || 'Control Panel';
  }, [kioskName]);

  useLayoutEffect(() => {
    setEditValue(deviceHost);
  }, [deviceHost]);

  const commitHost = () => {
    const v = editValue.trim();
    if (!v) return;
    setDeviceHost(v);
    const pathWithoutFirst = location.pathname.replace(/^\/[^/]+/, '') || '';
    navigate(`${pathWithoutFirst ? `/${v}${pathWithoutFirst}` : `/${v}`}`);
  };

  const p = panelInfo || {};
  const act = p.activity || 'inactive';
  const state = p.kiosk_status || 'UNKNOWN';
  const remoteUsers = terminals?.remote_users ?? [];
  const remoteCount = terminals?.remote_count ?? remoteUsers.length;
  const localCount = terminals?.local_count ?? 0;

  const valueOk = 'text-emerald-400';
  const valueWarn = 'text-amber-400';
  const valueError = 'text-destructive';

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 flex-col gap-3 border-b border-border bg-card px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-4">
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 text-card-foreground md:gap-4">
          <StatusDot variant={connected ? 'ok' : 'error'} />
          <input
            ref={deviceHostInputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitHost}
            onKeyDown={(e) => e.key === 'Enter' && commitHost()}
            placeholder="e.g. ns1136 or 192.168.1.1 — Ctrl+U to focus"
            title="Change and press Enter to connect. Ctrl+U to focus this field."
            className="min-w-0 max-w-[12rem] rounded border border-input bg-background px-2 py-1 text-lg font-semibold text-card-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring md:truncate"
            aria-label="Device host"
          />
          {!connected && (
            <button
              type="button"
              onClick={commitHost}
              className="shrink-0 rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              Connect
            </button>
          )}
          {kioskName && (
            <span className="min-w-0 text-sm text-muted-foreground md:truncate" title="Reported by device">
              ({kioskName})
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-card-foreground">
          <TitleItem
            icon={Terminal}
            label="Terminals:"
            title={remoteCount > 0 ? `SSH: ${remoteUsers.join(', ')}` : undefined}
          >
            <span className="tabular-nums">{remoteCount} SSH, {localCount} local</span>
          </TitleItem>
          <TitleItem
            icon={Gauge}
            label="Kiosk Status:"
            title="Overall health of the kiosk: ALL_SYSTEMS_GO (green), DEGRADED (red), or other states. Reflects abilities, devices, and processes."
          >
            <StatusDot variant={statusDotVariant(state)} />
            <span
              className={cn(
                state === 'ALL_SYSTEMS_GO' && valueOk,
                state === 'DEGRADED' && valueError,
                !['ALL_SYSTEMS_GO', 'DEGRADED'].includes(state) && valueWarn
              )}
            >
              {state}
            </span>
          </TitleItem>
          <TitleItem
            icon={Activity}
            label="Activity:"
            title="Whether the kiosk is Inactive (no customer), Active (customer using it), or in Service Mode."
          >
            <StatusDot
              variant={act === 'inactive' ? 'ok' : act === 'service' ? 'warn' : 'error'}
            />
            <span
              className={cn(
                act === 'inactive' && valueOk,
                act === 'active' && valueError,
                act === 'service' && valueWarn
              )}
            >
              {ACTIVITY_LABELS[act] ?? act}
            </span>
          </TitleItem>
          <TitleItem icon={Tag} label="Tag:">
            <span>{p.git_tag || '—'}</span>
          </TitleItem>
          <TitleItem icon={Layers} label="Generation:">
            <span>{p.generation || '—'}</span>
          </TitleItem>
          <TitleItem icon={Flag} label="Banner:">
            <span>{p.banner || '—'}</span>
          </TitleItem>
          <TitleItem icon={CheckCircle} label="Deployed:">
            <StatusDot variant={p.deployed ? 'ok' : 'warn'} />
            <span className={p.deployed ? valueOk : valueWarn}>{p.deployed ? 'Yes' : 'No'}</span>
          </TitleItem>
          <Separator orientation="vertical" className="hidden h-4 md:block" />
          <TitleItem icon={LinkIcon} label="Control Panel:">
            <StatusDot variant={connected ? 'ok' : 'error'} />
            <span className={connected ? valueOk : valueError}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </TitleItem>
          <Separator orientation="vertical" className="hidden h-4 md:block" />
          <button
            type="button"
            onClick={logout}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Sign out"
          >
            <LogOut className="size-4" />
            <span className="hidden md:inline">Sign out</span>
          </button>
        </div>
      </header>

      {connectionRejected && (
        <div className="shrink-0 bg-amber-500/15 px-4 py-2 text-center text-sm text-amber-800 dark:text-amber-200" role="alert">
          {connectionRejected}
        </div>
      )}
      {disconnectedDueToInactivity && !connected && (
        <div className="shrink-0 bg-amber-500/15 px-4 py-2 text-center text-sm text-amber-800 dark:text-amber-200" role="alert">
          You were disconnected due to inactivity. Connect again to continue.
        </div>
      )}
      {!connected && deviceHost.trim() && !connectionRejected && !disconnectedDueToInactivity && (
        <div className="shrink-0 bg-amber-500/15 px-4 py-2 text-center text-sm text-amber-800 dark:text-amber-200" role="alert">
          {lastError ? `Could not connect to the kiosk: ${lastError}` : 'No connection to the kiosk, only calibration page would be available.'}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AppSidebar panelInfo={panelInfo} />
        <main className="content min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

function requestKioskName(sock, setKioskName) {
  sock.request('get_kiosk_name').then((res) => {
    if (res.success && res.data) {
      const name = res.data.kiosk_name;
      setKioskName(typeof name === 'string' ? name : null);
    }
  }).catch(() => {});
}

function requestPanelInfo(sock, setPanelInfo) {
  sock.request('get_panel_info').then((res) => {
    if (res.success && res.data && typeof res.data === 'object') setPanelInfo(res.data);
  }).catch(() => {});
}

function requestActivity(sock, setPanelInfo) {
  sock.request('get_activity').then((res) => {
    if (res.success && res.data) {
      const a = res.data.activity;
      if (a !== undefined) setPanelInfo((prev) => (prev ? { ...prev, activity: a } : null));
    }
  }).catch(() => {});
}

function requestComputerStats(sock, setComputerStats) {
  sock.request('get_computer_stats').then((res) => {
    if (res.success && res.data && typeof res.data === 'object') setComputerStats(res.data);
  }).catch(() => {});
}

function requestTerminals(sock, setTerminals) {
  sock.request('get_terminals').then((res) => {
    if (res.success && res.data && typeof res.data === 'object') setTerminals(res.data);
  }).catch(() => {});
}

function requestWtfWhyDegraded(sock, setWtfWhyDegraded) {
  sock.request('get_wtf_why_degraded').then((res) => {
    if (res.success && res.data && typeof res.data === 'object') setWtfWhyDegraded(res.data);
  }).catch(() => {});
}

function requestStatusSections(sock, setStatusSections) {
  sock.request('get_status_sections').then((res) => {
    if (res.success && res.data && typeof res.data === 'object') setStatusSections(res.data);
  }).catch(() => {});
}

function requestConnectionCount(sock, setConnectionCount) {
  sock.request('get_connection_count').then((res) => {
    if (res.success && res.data != null) {
      const n = res.data.count;
      setConnectionCount(typeof n === 'number' ? n : null);
    }
  }).catch(() => {});
}

/** Request connection count and call callback(count). Used to gate connect setup by frontend limit. */
function requestConnectionCountWithCallback(sock, callback) {
  sock.request('get_connection_count').then((res) => {
    const n = res.success && res.data != null ? res.data.count : null;
    callback(typeof n === 'number' ? n : null);
  }).catch(() => callback(null));
}

/** Single request for all Status page data. Callback receives { computer_stats, connection_count, wtf_why_degraded, status_sections }. Terminals are requested separately so the header updates on all pages. */
function requestStatusSnapshot(sock, setComputerStats, setConnectionCount, setWtfWhyDegraded, setStatusSections) {
  sock.request('get_status_snapshot').then((res) => {
    if (!res.success || !res.data || typeof res.data !== 'object') return;
    const d = res.data;
    setComputerStats(d.computer_stats ?? null);
    setConnectionCount(typeof d.connection_count === 'number' ? d.connection_count : null);
    setWtfWhyDegraded(d.wtf_why_degraded ?? null);
    setStatusSections(d.status_sections ?? null);
  }).catch(() => {});
}

const STATUS_POLL_MS = 10000;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const FRONTEND_CONNECTION_LIMIT = 15; // If count > this, show message and disconnect.

const CONNECTION_ERROR_SUFFIX = ' Only calibration page would be available.';

const CONNECTION_ERROR_MESSAGES = {
  port: 'Port 2026 may not be accessible; check modem or device firewall.' + CONNECTION_ERROR_SUFFIX,
  refused: 'CONTROL_PANEL process may not be running on this device.' + CONNECTION_ERROR_SUFFIX,
  auth: 'Authentication may have failed; check login or permissions.' + CONNECTION_ERROR_SUFFIX,
  ssl: 'Possible SSL or certificate error.' + CONNECTION_ERROR_SUFFIX,
};

/** Map WebSocket close code/reason from cloud proxy to user-facing message, or null. */
function getConnectionErrorMessage(code, reason) {
  if (code === 4401 || code === 4500) return CONNECTION_ERROR_MESSAGES.auth;
  if (code === 1011) {
    const r = (reason || '').toLowerCase();
    if (r.includes('ssl')) return CONNECTION_ERROR_MESSAGES.ssl;
    if (r.includes('refused')) return CONNECTION_ERROR_MESSAGES.refused;
    return CONNECTION_ERROR_MESSAGES.port;
  }
  if (code === 1006 || (code !== 1000 && code !== undefined)) {
    return CONNECTION_ERROR_MESSAGES.port;
  }
  return null;
}

/** True when route is Status (root or :kiosk index). */
function isStatusPage(pathname) {
  return pathname === '/' || /^\/[^/]+$/.test(pathname);
}

/** Redirect to /login if not authenticated. */
function RequireAuth({ children }) {
  const location = useLocation();
  const token = getToken();
  useEffect(() => {
    if (!token) return;
    apiFetch('/api/ping').catch(() => {});
  }, [token]);
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

function AppContent() {
  const location = useLocation();
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  const [deviceHost, setDeviceHost] = useState(() => getInitialDeviceHost());
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [kioskName, setKioskName] = useState(null);
  const [panelInfo, setPanelInfo] = useState(null);
  const [computerStats, setComputerStats] = useState(null);
  const [wtfWhyDegraded, setWtfWhyDegraded] = useState(null);
  const [statusSections, setStatusSections] = useState(null);
  const [terminals, setTerminals] = useState(null);
  const [connectionCount, setConnectionCount] = useState(null);
  const [lastError, setLastError] = useState(null);
  const [connectionRejected, setConnectionRejected] = useState(null);
  const [disconnectedDueToInactivity, setDisconnectedDueToInactivity] = useState(false);
  const inactivityTimerRef = useRef(null);

  useEffect(() => {
    const wsUrl = buildWsUrl(deviceHost);
    const sock = createDeviceSocket(wsUrl);
    setSocket(sock);
    return () => sock.disconnect();
  }, [deviceHost]);

  useEffect(() => {
    if (!socket) return;
    let pollInterval = null;
    const tick = () => {
      requestPanelInfo(socket, setPanelInfo);
      requestTerminals(socket, setTerminals);
      if (isStatusPage(pathnameRef.current)) {
        requestStatusSnapshot(socket, setComputerStats, setConnectionCount, setWtfWhyDegraded, setStatusSections);
      }
    };
    const finishConnectionSetup = () => {
      setConnectionRejected(null);
      setDisconnectedDueToInactivity(false);
      setLastError(null);
      setConnected(true);
      requestKioskName(socket, setKioskName);
      requestPanelInfo(socket, setPanelInfo);
      requestTerminals(socket, setTerminals);
      tick();
      pollInterval = setInterval(tick, STATUS_POLL_MS);
    };
    const onConnect = () => {
      requestConnectionCountWithCallback(socket, (count) => {
        setConnectionCount(count);
        if (count != null && count > FRONTEND_CONNECTION_LIMIT) {
          setConnectionRejected(`Too many viewers connected to this kiosk (limit ${FRONTEND_CONNECTION_LIMIT}). Try again later.`);
          socket.disconnect();
          return;
        }
        finishConnectionSetup();
      });
    };
    const onDisconnect = (closeInfo) => {
      setConnected(false);
      setKioskName(null);
      setPanelInfo(null);
      setComputerStats(null);
      setWtfWhyDegraded(null);
      setStatusSections(null);
      setTerminals(null);
      setConnectionCount(null);
      const msg = closeInfo && getConnectionErrorMessage(closeInfo.code, closeInfo.reason);
      setLastError(msg ?? null);
      if (pollInterval) clearInterval(pollInterval);
    };

    socket.onConnect(onConnect);
    socket.onDisconnect(onDisconnect);
    if (socket.connected) onConnect();

    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [socket]);

  // When navigating to Status page (or when connection establishes on Status), pull updates immediately once.
  useEffect(() => {
    if (!socket || !connected || !isStatusPage(location.pathname)) return;
    requestStatusSnapshot(socket, setComputerStats, setConnectionCount, setWtfWhyDegraded, setStatusSections);
  }, [location.pathname, connected, socket]);

  // Inactivity timeout: disconnect after 15 min with no user activity (only when connected).
  useEffect(() => {
    if (!socket || !connected) {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      return;
    }
    const scheduleDisconnect = () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = setTimeout(() => {
        inactivityTimerRef.current = null;
        setDisconnectedDueToInactivity(true);
        socket.disconnect();
      }, INACTIVITY_TIMEOUT_MS);
    };
    const activityEvents = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    scheduleDisconnect();
    activityEvents.forEach((ev) => window.addEventListener(ev, scheduleDisconnect));
    return () => {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      activityEvents.forEach((ev) => window.removeEventListener(ev, scheduleDisconnect));
    };
  }, [socket, connected]);

  return (
      <DeviceHostContext.Provider value={{ deviceHost, setDeviceHost }}>
        <Layout
          kioskName={kioskName}
          connected={connected}
          lastError={lastError}
          connectionRejected={connectionRejected}
          disconnectedDueToInactivity={disconnectedDueToInactivity}
          panelInfo={panelInfo}
          terminals={terminals}
        >
          <Routes>
            <Route path="/" element={<Status connected={connected} computerStats={computerStats} wtfWhyDegraded={wtfWhyDegraded} status={statusSections} terminals={terminals} connectionCount={connectionCount} />} />
            <Route path=":kiosk" element={<KioskSync />}>
              <Route index element={<Status connected={connected} computerStats={computerStats} wtfWhyDegraded={wtfWhyDegraded} status={statusSections} terminals={terminals} connectionCount={connectionCount} />} />
              <Route path="calibration" element={<Calibration />}>
                <Route index element={<CalibrationIndexRedirect />} />
                <Route path="report" element={<CalibrationReport />} />
                <Route path="report/testcuts/latest" element={<WrapKiosk component={CalibrationLatestRedirect} sectionId="testcuts" />} />
                <Route path="report/testcuts/:id" element={<Suspense fallback={<div className="p-4 text-muted-foreground text-sm">Loading…</div>}><WrapKiosk component={TestcutsImagesPage} /></Suspense>} />
                <Route path="report/bitting_calibration/latest" element={<WrapKiosk component={CalibrationLatestRedirect} sectionId="bitting_calibration" />} />
                <Route path="report/bitting_calibration/:date" element={<Suspense fallback={<div className="p-4 text-muted-foreground text-sm">Loading…</div>}><WrapKiosk component={BittingCalibrationImagesPage} /></Suspense>} />
                <Route path="report/bump_tower_calibration/latest" element={<WrapKiosk component={CalibrationLatestRedirect} sectionId="bump_tower_calibration" />} />
                <Route path="report/bump_tower_calibration/:runId" element={<Suspense fallback={<div className="p-4 text-muted-foreground text-sm">Loading…</div>}><WrapKiosk component={RunBasedCalibrationImagesPage} sectionId="bump_tower_calibration" /></Suspense>} />
                <Route path="report/grip_calibration/latest" element={<WrapKiosk component={CalibrationLatestRedirect} sectionId="grip_calibration" />} />
                <Route path="report/grip_calibration/:runId" element={<Suspense fallback={<div className="p-4 text-muted-foreground text-sm">Loading…</div>}><WrapKiosk component={RunBasedCalibrationImagesPage} sectionId="grip_calibration" /></Suspense>} />
                <Route path="report/gripper_cam_calibration/latest" element={<WrapKiosk component={CalibrationLatestRedirect} sectionId="gripper_cam_calibration" />} />
                <Route path="report/gripper_cam_calibration/:runId" element={<Suspense fallback={<div className="p-4 text-muted-foreground text-sm">Loading…</div>}><WrapKiosk component={RunBasedCalibrationImagesPage} sectionId="gripper_cam_calibration" /></Suspense>} />
                <Route path="report/gripper_leds_check/latest" element={<WrapKiosk component={CalibrationLatestRedirect} sectionId="gripper_leds_check" />} />
                <Route path="report/gripper_leds_check/:runId" element={<Suspense fallback={<div className="p-4 text-muted-foreground text-sm">Loading…</div>}><WrapKiosk component={RunBasedCalibrationImagesPage} sectionId="gripper_leds_check" /></Suspense>} />
                <Route path="report/overhead_cam_calibration/latest" element={<WrapKiosk component={CalibrationLatestRedirect} sectionId="overhead_cam_calibration" />} />
                <Route path="report/overhead_cam_calibration/:runId" element={<Suspense fallback={<div className="p-4 text-muted-foreground text-sm">Loading…</div>}><WrapKiosk component={RunBasedCalibrationImagesPage} sectionId="overhead_cam_calibration" /></Suspense>} />
                <Route path="report/pickup_y_calibration/latest" element={<WrapKiosk component={CalibrationLatestRedirect} sectionId="pickup_y_calibration" />} />
                <Route path="report/pickup_y_calibration/:runId" element={<Suspense fallback={<div className="p-4 text-muted-foreground text-sm">Loading…</div>}><WrapKiosk component={RunBasedCalibrationImagesPage} sectionId="pickup_y_calibration" /></Suspense>} />
                <Route path="report/:sectionId" element={<WrapKiosk component={CalibrationReportSection} />} />
                <Route path="tracing" element={<CalibrationTracingIndexRedirect />} />
                <Route path="tracing/gripper-cam/latest" element={<WrapKiosk component={CalibrationTracingLatestRedirect} />} />
                <Route path="tracing/gripper-cam" element={<WrapKiosk component={CalibrationTracingGripperCam} />} />
                <Route path="tracing/gripper-cam/:runId" element={<WrapKiosk component={CalibrationTracingGripperCam} />} />
              </Route>
              <Route path="cameras" element={<CameraImagesPage socket={socket} />} />
              <Route path="config" element={<ConfigPage socket={socket} />} />
              <Route path="data-usage" element={<DataUsage socket={socket} />} />
              <Route path="wellness" element={<WellnessCheck socket={socket} />} />
              <Route path="fleet" element={<FleetCommands connected={connected} socket={socket} />} />
              <Route path="logs" element={<LogTailPage socket={socket} />} />
            </Route>
          </Routes>
        </Layout>
      </DeviceHostContext.Provider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/*" element={<RequireAuth><AppContent /></RequireAuth>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
