import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import CornerstoneViewer from '@/components/CornerstoneViewer';
import { apiUrl } from '@/lib/apiUrl';

export default function TestcutsImagesPage({ kioskName: kioskNameProp }) {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const kioskName = searchParams.get('kiosk_name') || kioskNameProp;
  const testcutsPath = kioskName ? `/${kioskName}/calibration/report/testcuts` : '/calibration/report/testcuts';
  const [sections, setSections] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fullscreenGallery, setFullscreenGallery] = useState(null); // { images: [], index: number } | null
  const [cornerstoneImage, setCornerstoneImage] = useState(null);

  useEffect(() => {
    if (!kioskName || !id) {
      setLoading(false);
      if (!kioskName) setError('Kiosk name not available');
      return;
    }
    setLoading(true);
    setError(null);
    fetch(apiUrl(`/api/calibration/testcuts/images?kiosk=${encodeURIComponent(kioskName)}&id=${encodeURIComponent(id)}`))
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText || 'Failed to load images');
        return res.json();
      })
      .then(setSections)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [kioskName, id]);

  const closeFullscreenAndCornerstone = useCallback(() => {
    setFullscreenGallery(null);
    setCornerstoneImage(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        closeFullscreenAndCornerstone();
        return;
      }
      if (!fullscreenGallery) return;
      const { images, index } = fullscreenGallery;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setFullscreenGallery((prev) => ({ ...prev, index: (prev.index - 1 + prev.images.length) % prev.images.length }));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setFullscreenGallery((prev) => ({ ...prev, index: (prev.index + 1) % prev.images.length }));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeFullscreenAndCornerstone, fullscreenGallery]);

  if (!kioskName) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-sm">Kiosk name not available.</p>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-sm">Loading images…</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-destructive text-sm">{error}</p>
          <button
            type="button"
            onClick={() => navigate(testcutsPath)}
            className="mt-2 text-sm underline"
          >
            Back to Testcuts
          </button>
        </CardContent>
      </Card>
    );
  }

  if (!sections || Object.keys(sections).length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-sm">No images for this ID.</p>
          <button
            type="button"
            onClick={() => navigate(testcutsPath)}
            className="mt-2 text-sm underline"
          >
            Back to Testcuts
          </button>
        </CardContent>
      </Card>
    );
  }

  const sectionNames = Object.keys(sections);
  const allImages = sectionNames.flatMap((sn) => sections[sn]);

  const openFullscreenAt = (img) => {
    const index = allImages.findIndex((i) => i.key === img.key);
    setFullscreenGallery({ images: allImages, index: index >= 0 ? index : 0 });
  };

  const goPrev = () => {
    setFullscreenGallery((prev) => ({ ...prev, index: (prev.index - 1 + prev.images.length) % prev.images.length }));
  };
  const goNext = () => {
    setFullscreenGallery((prev) => ({ ...prev, index: (prev.index + 1) % prev.images.length }));
  };

  return (
    <>
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate(testcutsPath)}
          className="text-sm text-muted-foreground hover:text-foreground underline"
        >
          Back to Testcuts
        </button>
        <span className="text-muted-foreground text-sm">ID: {id}</span>
      </div>
      {sectionNames.map((sectionName) => (
        <Card key={sectionName}>
          <CardHeader>
            <CardTitle className="text-base">{sectionName.replace(/_/g, ' ')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {sections[sectionName].map((img) => (
              <div key={img.key} className="flex flex-col gap-2">
                <img
                  src={img.url}
                  alt={img.filename}
                  className="max-h-96 w-auto max-w-full cursor-pointer rounded border border-border object-contain hover:opacity-90"
                  onClick={() => openFullscreenAt(img)}
                  title="Click for full screen (use arrows or ← → to navigate)"
                />
                <p className="text-muted-foreground text-xs">{img.filename}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
                    onClick={() => openFullscreenAt(img)}
                  >
                    Full screen
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border px-3 py-1.5 text-sm"
                    onClick={() => setCornerstoneImage(img)}
                  >
                    Open with Cornerstone
                  </button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>

    {fullscreenGallery && (() => {
      const { images, index } = fullscreenGallery;
      const current = images[index];
      if (!current) return null;
      return (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black"
          role="dialog"
          aria-modal="true"
          aria-label="Full screen gallery"
        >
          <img
            src={current.url}
            alt={current.filename}
            className="max-h-full max-w-full object-contain"
          />
          {images.length > 1 && (
            <>
              <button
                type="button"
                onClick={goPrev}
                className="absolute left-4 top-1/2 -translate-y-1/2 rounded bg-white/90 px-3 py-2 text-lg font-medium text-black hover:bg-white"
                aria-label="Previous image"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={goNext}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded bg-white/90 px-3 py-2 text-lg font-medium text-black hover:bg-white"
                aria-label="Next image"
              >
                ›
              </button>
              <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-black/60 px-3 py-1.5 text-sm text-white">
                {index + 1} / {images.length}
              </span>
            </>
          )}
          <button
            type="button"
            onClick={() => setFullscreenGallery(null)}
            className="absolute right-4 top-4 rounded bg-white/90 px-4 py-2 text-sm font-medium text-black hover:bg-white"
          >
            Exit full screen (Esc)
          </button>
        </div>
      );
    })()}

    <Dialog open={!!cornerstoneImage} onOpenChange={(open) => !open && setCornerstoneImage(null)}>
      <DialogContent
        className="fixed inset-0 z-50 h-screen w-screen max-h-none max-w-none translate-x-0 translate-y-0 rounded-none border-0 p-4 overflow-auto"
        onClose={closeFullscreenAndCornerstone}
      >
        <DialogTitle className="sr-only">Image measurement (Esc to close)</DialogTitle>
        <DialogDescription className="sr-only">
          Measure and view the image with Cornerstone tools. Press Escape to close.
        </DialogDescription>
        {cornerstoneImage && (
          <div className="h-full w-full min-h-0 flex flex-col">
            <CornerstoneViewer imageUrl={cornerstoneImage.url} pixelSpacing={1} />
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
