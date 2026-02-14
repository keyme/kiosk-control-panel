import { useState, useCallback, useRef, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import { Download, Loader2, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import JSONEditor from 'jsoneditor';
import 'jsoneditor/dist/jsoneditor.min.css';

const GLOBAL_HARDWARE_LABEL = 'Global (hardware)';
const HARDWARE_FILENAME = 'hardware.json';

export default function ConfigPage({ socket }) {
  const [configs, setConfigs] = useState(null);
  const [hardware, setHardware] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedProcess, setSelectedProcess] = useState(null);
  const [selectedFilename, setSelectedFilename] = useState(null);
  const editorRef = useRef(null);
  const editorInstanceRef = useRef(null);

  const fetchConfigs = useCallback(() => {
    if (!socket || loading) return;
    setLoading(true);
    setError(null);
    socket.request('get_all_configs').then((res) => {
      setLoading(false);
      if (res?.success && res?.data != null) {
        setConfigs(res.data.configs ?? {});
        setHardware(
          res.data.hardware != null && typeof res.data.hardware === 'object'
            ? res.data.hardware
            : null
        );
        setError(null);
        setSelectedProcess(null);
        setSelectedFilename(null);
      } else {
        const errMsg = Array.isArray(res?.errors)
          ? res.errors.join(', ')
          : res?.errors ?? 'Failed to load configs';
        setError(errMsg);
      }
    }).catch(() => setLoading(false));
  }, [socket, loading]);

  const processes = [
    ...(hardware != null ? [GLOBAL_HARDWARE_LABEL] : []),
    ...(configs ? Object.keys(configs).sort() : []),
  ];
  const filenames =
    selectedProcess === GLOBAL_HARDWARE_LABEL
      ? [HARDWARE_FILENAME]
      : configs && selectedProcess && configs[selectedProcess]
        ? Object.keys(configs[selectedProcess]).sort()
        : [];
  const selectedConfig =
    selectedProcess === GLOBAL_HARDWARE_LABEL && selectedFilename === HARDWARE_FILENAME
      ? hardware
      : configs && selectedProcess && selectedFilename
        ? configs[selectedProcess][selectedFilename]
        : null;

  const hasConfigs =
    (configs && Object.keys(configs).length > 0) || hardware != null;

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (selectedConfig === null || selectedConfig === undefined) {
      if (editorInstanceRef.current) {
        editorInstanceRef.current.destroy();
        editorInstanceRef.current = null;
      }
      return;
    }
    if (editorInstanceRef.current) {
      editorInstanceRef.current.destroy();
      editorInstanceRef.current = null;
    }
    const editor = new JSONEditor(el, {
      mode: 'view',
      navigationBar: true,
      search: true,
      sortObjectKeys: true,
    });
    editor.set(selectedConfig);
    editorInstanceRef.current = editor;
    return () => {
      if (editorInstanceRef.current) {
        editorInstanceRef.current.destroy();
        editorInstanceRef.current = null;
      }
    };
  }, [selectedProcess, selectedFilename, selectedConfig]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageTitle icon={Settings}>Kiosk config</PageTitle>
      <p className="text-muted-foreground -mt-2 text-sm">
        View merged config and hardware manifest from this kiosk. Configs are loaded per process
        (global defaults plus hardware-specific and local overrides). &quot;Global (hardware)&quot; is
        the top-level hardware manifest (config/hardware.json). Read-only.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={fetchConfigs}
          disabled={loading || !socket?.connected}
          className={cn(
            'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
            'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none'
          )}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Download className="size-4" aria-hidden />
          )}
          Fetch config from kiosk
        </button>
        {loading && (
          <span className="text-muted-foreground text-sm">Loading configs…</span>
        )}
      </div>
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {!hasConfigs && !loading && !error && (
        <p className="text-muted-foreground text-sm">
          Click &quot;Fetch config from kiosk&quot; to load configs.
        </p>
      )}
      {hasConfigs && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,12rem)_minmax(0,16rem)_1fr]">
          <Card>
            <CardContent className="p-2">
              <div className="text-muted-foreground mb-1.5 text-xs font-medium uppercase tracking-wider">
                Process
              </div>
              <ul className="max-h-[60vh] overflow-y-auto">
                {processes.map((p) => (
                  <li key={p}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedProcess(p);
                        setSelectedFilename(
                          p === GLOBAL_HARDWARE_LABEL ? HARDWARE_FILENAME : null
                        );
                      }}
                      className={cn(
                        'w-full rounded px-2 py-1.5 text-left text-sm',
                        selectedProcess === p
                          ? 'bg-sidebar-accent font-medium'
                          : 'hover:bg-muted'
                      )}
                    >
                      {p}
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-2">
              <div className="text-muted-foreground mb-1.5 text-xs font-medium uppercase tracking-wider">
                File
              </div>
              {selectedProcess ? (
                <ul className="max-h-[60vh] overflow-y-auto">
                  {filenames.map((f) => (
                    <li key={f}>
                      <button
                        type="button"
                        onClick={() => setSelectedFilename(f)}
                        className={cn(
                          'w-full rounded px-2 py-1.5 text-left text-sm',
                          selectedFilename === f
                            ? 'bg-sidebar-accent font-medium'
                            : 'hover:bg-muted'
                        )}
                      >
                        {f}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground py-2 text-sm">
                  Select a process
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="min-h-[400px] p-4">
              {selectedProcess && selectedFilename ? (
                selectedConfig === null ? (
                  <p className="text-muted-foreground text-sm">
                    Failed to load
                  </p>
                ) : (
                  <div
                    ref={editorRef}
                    className="config-json-editor h-[60vh] min-h-[300px] [&_.jsoneditor]:border-0 [&_.jsoneditor]:!h-full"
                  />
                )
              ) : (
                <p className="text-muted-foreground text-sm">
                  Select a process and file
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
