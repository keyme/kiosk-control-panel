import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, NavLink, useNavigate } from 'react-router-dom';
import { Activity, Camera, Flag, Heart, MapPin, Radio, Wrench, ChevronDown, ChevronRight, FileText, Video, Search, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CALIBRATION_REPORT_SECTIONS, formatSectionLabel } from '@/pages/calibrationReportSections';

const QUICK_OPEN_PAGES = [
  { path: '/', label: 'Status' },
  { path: '/cameras', label: 'Camera images' },
  { path: '/config', label: 'Config' },
  { path: '/calibration/report', label: 'Calibration Reports' },
  { path: '/calibration/report/testcuts', label: 'Testcuts' },
  ...CALIBRATION_REPORT_SECTIONS.map((id) => ({ path: `/calibration/report/${id}`, label: formatSectionLabel(id) })),
  { path: '/calibration/tracing/gripper-cam', label: 'Gripper Cam Calibration' },
  { path: '/wellness', label: 'Wellness Check' },
  { path: '/data-usage', label: 'Data Usage' },
  { path: '/fleet', label: 'Fleet Commands' },
];

function StoreInfo({ store }) {
  const bn = store?.banner_name ?? '';
  const addr = store?.store_address ?? '';
  return (
    <div className="flex flex-col gap-1.5 px-3 py-3">
      <div className="text-sidebar-foreground/70 text-xs font-medium uppercase tracking-wider">
        Store
      </div>
      <div className="flex items-start gap-2 text-sm">
        <Flag className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="text-sidebar-foreground font-medium">{bn || '—'}</span>
      </div>
      <div className="flex items-start gap-2 text-sm">
        <MapPin className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
        {addr ? (
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-sidebar-foreground break-words text-xs leading-snug underline-offset-2 hover:underline"
          >
            {addr}
          </a>
        ) : (
          <span className="text-muted-foreground text-xs leading-snug">—</span>
        )}
      </div>
    </div>
  );
}

const linkClass = ({ isActive }) =>
  cn(
    'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
      : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
  );

function filterPages(pages, query) {
  const q = query.trim().toLowerCase();
  if (!q) return pages;
  return pages.filter((p) => p.label.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
}

export function AppSidebar({ panelInfo }) {
  const location = useLocation();
  const navigate = useNavigate();
  const pathSegments = location.pathname.split('/').filter(Boolean);
  const kiosk = pathSegments.length >= 1 ? pathSegments[0] : '';
  const prefix = kiosk ? `/${kiosk}` : '';
  const isCalibration = location.pathname.includes('/calibration');
  const isReport = location.pathname.includes('/calibration/report');
  const isTracing = location.pathname.includes('/calibration/tracing');

  const [calibrationOpen, setCalibrationOpen] = useState(isCalibration);
  const [reportsOpen, setReportsOpen] = useState(isReport);
  const [tracingOpen, setTracingOpen] = useState(isTracing);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchInputRef = useRef(null);

  const filteredPages = filterPages(QUICK_OPEN_PAGES, searchQuery);
  const showResults = searchOpen && searchQuery.trim().length > 0;

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchQuery('');
    setSelectedIndex(0);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openSearch]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Escape') {
      setSearchOpen(false);
      searchInputRef.current?.blur();
      return;
    }
    if (!showResults) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const page = filteredPages[selectedIndex];
      if (page) {
        const targetPath = prefix ? (page.path === '/' ? prefix : `${prefix}${page.path}`) : page.path;
        navigate(targetPath);
        setSearchOpen(false);
        setSearchQuery('');
        searchInputRef.current?.blur();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % filteredPages.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + filteredPages.length) % filteredPages.length);
    }
  };

  useEffect(() => {
    if (isCalibration) setCalibrationOpen(true);
    if (isReport) setReportsOpen(true);
    if (isTracing) setTracingOpen(true);
  }, [isCalibration, isReport, isTracing]);

  return (
    <aside
      className="flex min-h-0 w-52 shrink-0 flex-col self-stretch border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      aria-label="Sidebar"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto py-2">
        <div className="relative px-2 pb-2">
          <div className="flex items-center gap-1.5 rounded-md border border-sidebar-border bg-sidebar-accent/50 px-2 py-1.5">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Go to page… (Ctrl+I)"
              className="min-w-0 flex-1 bg-transparent text-sm text-sidebar-foreground placeholder:text-muted-foreground focus:outline-none"
              aria-label="Quick open page"
              aria-expanded={showResults}
              aria-controls="quick-open-results"
            />
          </div>
          {showResults && (
            <ul
              id="quick-open-results"
              className="absolute left-2 right-2 top-full z-50 mt-1 max-h-60 overflow-auto rounded-md border border-sidebar-border bg-sidebar py-1 shadow-lg"
              role="listbox"
            >
              {filteredPages.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">No matches</li>
              ) : (
                filteredPages.map((page, i) => (
                  <li key={page.path}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === selectedIndex}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        const targetPath = prefix ? (page.path === '/' ? prefix : `${prefix}${page.path}`) : page.path;
                        navigate(targetPath);
                        setSearchOpen(false);
                        setSearchQuery('');
                        searchInputRef.current?.blur();
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                        i === selectedIndex
                          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      )}
                    >
                      {page.label}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
        <NavLink to={prefix || '/'} end className={linkClass}>
          <Activity className="size-4 shrink-0" aria-hidden />
          Status
        </NavLink>


        <div>
          <button
            type="button"
            onClick={() => setCalibrationOpen((o) => !o)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
              isCalibration
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            )}
            aria-expanded={calibrationOpen}
          >
            <Wrench className="size-4 shrink-0" aria-hidden />
            Calibration
          </button>
          {calibrationOpen && (
            <div className="ml-2 mt-0.5 flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      setReportsOpen((o) => !o);
                    }}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    aria-expanded={reportsOpen}
                    aria-label={reportsOpen ? 'Collapse Calibration Reports' : 'Expand Calibration Reports'}
                  >
                    {reportsOpen ? (
                      <ChevronDown className="size-3.5" aria-hidden />
                    ) : (
                      <ChevronRight className="size-3.5" aria-hidden />
                    )}
                  </button>
                  <NavLink
                    to={prefix ? `${prefix}/calibration/report` : '/calibration/report'}
                    end
                    className={({ isActive }) =>
                      cn(
                        'flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                        isActive
                          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      )
                    }
                  >
                    <FileText className="size-3.5 shrink-0" aria-hidden />
                    Calibration Reports
                  </NavLink>
                </div>
                {reportsOpen &&
                  CALIBRATION_REPORT_SECTIONS.map((sectionId) => (
                    <NavLink
                      key={sectionId}
                      to={prefix ? `${prefix}/calibration/report/${sectionId}` : `/calibration/report/${sectionId}`}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center rounded-md py-1.5 pl-8 pr-2 text-sm transition-colors',
                          isActive
                            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                        )
                      }
                    >
                      {formatSectionLabel(sectionId)}
                    </NavLink>
                  ))}
              </div>
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      setTracingOpen((o) => !o);
                    }}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    aria-expanded={tracingOpen}
                    aria-label={tracingOpen ? 'Collapse Calibration Tracing' : 'Expand Calibration Tracing'}
                  >
                    {tracingOpen ? (
                      <ChevronDown className="size-3.5" aria-hidden />
                    ) : (
                      <ChevronRight className="size-3.5" aria-hidden />
                    )}
                  </button>
                  <NavLink
                    to={prefix ? `${prefix}/calibration/tracing/gripper-cam` : '/calibration/tracing/gripper-cam'}
                    className={({ isActive }) =>
                      cn(
                        'flex-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                        isActive
                          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      )
                    }
                  >
                    <Video className="size-3.5 shrink-0" aria-hidden />
                    Calibration Tracing
                  </NavLink>
                </div>
                {tracingOpen && (
                  <NavLink
                    to={prefix ? `${prefix}/calibration/tracing/gripper-cam` : '/calibration/tracing/gripper-cam'}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center rounded-md py-1.5 pl-8 pr-2 text-sm transition-colors',
                        isActive
                          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      )
                    }
                  >
                    Gripper Cam Calibration
                  </NavLink>
                )}
              </div>
            </div>
          )}
        </div>

        <NavLink to={prefix ? `${prefix}/cameras` : '/cameras'} className={linkClass}>
          <Camera className="size-4 shrink-0" aria-hidden />
          Camera images
        </NavLink>

        <NavLink to={prefix ? `${prefix}/config` : '/config'} className={linkClass}>
          <FileText className="size-4 shrink-0" aria-hidden />
          Config
        </NavLink>

        <NavLink to={prefix ? `${prefix}/data-usage` : '/data-usage'} className={linkClass}>
          <BarChart3 className="size-4 shrink-0" aria-hidden />
          Data Usage
        </NavLink>

        <NavLink to={prefix ? `${prefix}/wellness` : '/wellness'} className={linkClass}>
          <Heart className="size-4 shrink-0" aria-hidden />
          Wellness Check
        </NavLink>
        <NavLink to={prefix ? `${prefix}/fleet` : '/fleet'} className={linkClass}>
          <Radio className="size-4 shrink-0" aria-hidden />
          Fleet Commands
        </NavLink>
      </div>
      <div className="shrink-0 border-t border-sidebar-border">
        <StoreInfo store={panelInfo} />
      </div>
    </aside>
  );
}
