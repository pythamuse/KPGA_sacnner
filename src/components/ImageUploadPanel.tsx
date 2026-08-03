import React, { useEffect, useRef, useState } from 'react';
import { withTimeout } from '@/lib/pdf/withTimeout';
import { loadOpenCv } from '@/lib/documentScanner/loadOpenCv';
import { detectDocumentQuad, warpToRectangle } from '@/lib/documentScanner/perspectiveCorrect';
import { cagiTemplate, satisfactionTemplate } from '@/lib/recognition/roiTemplates';

export type UploadMode = 'sequential' | 'batch';

interface ImageUploadPanelProps {
  mode: UploadMode;
  jobId: string;
  onAnalyzeTrigger: () => void;
  onUploadProgressChange?: (isProcessing: boolean) => void;
  onUploadSuccess: (type: 'cagi' | 'satisfaction', imageId: string, filename: string) => void;
}

type UploadKind = 'cagi' | 'satisfaction';

const MAX_UPLOAD_IMAGE_BYTES = 3.8 * 1024 * 1024;
const PERSPECTIVE_CORRECTION_SCALE = 3;
const PDF_RENDER_OPTIONS = [
  { scale: 1.5, quality: 0.86 },
  { scale: 1.25, quality: 0.82 },
  { scale: 1.0, quality: 0.78 },
];
const IMAGE_SHRINK_OPTIONS = [
  { scale: 1.0, quality: 0.86 },
  { scale: 0.85, quality: 0.82 },
  { scale: 0.7, quality: 0.78 },
  { scale: 0.55, quality: 0.74 },
];

const canvasToBlob = (canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> => (
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PDF 페이지 이미지를 만들 수 없습니다.'));
    }, mimeType, quality);
  })
);

const toJpegFilename = (filename: string): string => {
  const basename = filename.replace(/\.[^/.]+$/, '');
  return `${basename || 'upload'}.jpg`;
};

const loadImageFile = async (file: File): Promise<ImageBitmap | HTMLImageElement> => {
  if ('createImageBitmap' in window) {
    return await createImageBitmap(file);
  }

  return await new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('이미지 파일을 읽을 수 없습니다.'));
    };
    image.src = objectUrl;
  });
};

const getImageDimensions = (image: ImageBitmap | HTMLImageElement) => {
  if (image instanceof HTMLImageElement) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }

  return { width: image.width, height: image.height };
};

const shrinkImageFileIfNeeded = async (file: File, maxBytes: number): Promise<File> => {
  if (file.size <= maxBytes) {
    return file;
  }

  const image = await loadImageFile(file);
  const { width, height } = getImageDimensions(image);
  let fallbackBlob: Blob | null = null;

  try {
    for (const option of IMAGE_SHRINK_OPTIONS) {
      const canvas = document.createElement('canvas');
      const targetWidth = Math.max(1, Math.round(width * option.scale));
      const targetHeight = Math.max(1, Math.round(height * option.scale));
      const context = canvas.getContext('2d');

      if (!context) {
        throw new Error('브라우저에서 이미지를 그릴 수 없습니다.');
      }

      canvas.width = targetWidth;
      canvas.height = targetHeight;
      context.drawImage(image, 0, 0, targetWidth, targetHeight);

      const blob = await canvasToBlob(canvas, 'image/jpeg', option.quality);
      canvas.width = 1;
      canvas.height = 1;

      fallbackBlob = blob;
      if (blob.size <= maxBytes) {
        return new File([blob], toJpegFilename(file.name), { type: 'image/jpeg' });
      }
    }

    if (!fallbackBlob) {
      return file;
    }

    return new File([fallbackBlob], toJpegFilename(file.name), { type: 'image/jpeg' });
  } finally {
    if ('close' in image) {
      image.close();
    }
  }
};

export default function ImageUploadPanel({
  mode,
  jobId,
  onAnalyzeTrigger,
  onUploadProgressChange,
  onUploadSuccess,
}: ImageUploadPanelProps) {
  const [cagiFile, setCagiFile] = useState<{ name: string; preview: string } | null>(null);
  const [satFile, setSatFile] = useState<{ name: string; preview: string } | null>(null);
  const [isCagiUploading, setIsCagiUploading] = useState(false);
  const [isSatUploading, setIsSatUploading] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);

  const [cagiCount, setCagiCount] = useState<number>(0);
  const [satCount, setSatCount] = useState<number>(0);
  const [batchStatusMessage, setBatchStatusMessage] = useState<string>('');
  const [isBatchProcessing, setIsBatchProcessing] = useState<boolean>(false);
  const [isCameraStarting, setIsCameraStarting] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string>('');
  const [cameraFlow, setCameraFlow] = useState<{
    active: boolean;
    step: UploadKind;
    completed: UploadKind[];
  }>({ active: false, step: 'cagi', completed: [] });
  const [correctionPreview, setCorrectionPreview] = useState<{
    canvas: HTMLCanvasElement;
    step: UploadKind;
    previewSrc: string;
    source: 'camera' | 'file';
  } | null>(null);

  const cagiInputRef = useRef<HTMLInputElement>(null);
  const satInputRef = useRef<HTMLInputElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    onUploadProgressChange?.(isBatchProcessing || isCagiUploading || isSatUploading || isCameraStarting || isCapturing);
  }, [isBatchProcessing, isCagiUploading, isSatUploading, isCameraStarting, isCapturing, onUploadProgressChange]);

  useEffect(() => {
    if (cameraFlow.active && cameraVideoRef.current && cameraStreamRef.current) {
      cameraVideoRef.current.srcObject = cameraStreamRef.current;
      cameraVideoRef.current.play().catch((err) => {
        console.warn('camera video play() failed', err);
      });
    }
  }, [cameraFlow.active]);

  const renderPdfPageToFile = async (page: any, type: UploadKind, pageNumber: number): Promise<File> => {
    let fallbackBlob: Blob | null = null;
    const pageIndexStr = String(pageNumber).padStart(3, '0');

    for (const option of PDF_RENDER_OPTIONS) {
      const viewport = page.getViewport({ scale: option.scale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');

      if (!context) {
        throw new Error('브라우저에서 PDF 페이지를 그릴 수 없습니다.');
      }

      canvas.height = viewport.height;
      canvas.width = viewport.width;
      await withTimeout(
        page.render({ canvasContext: context, viewport }).promise,
        20000,
        `${pageNumber}페이지 변환이 시간 내에 끝나지 않았습니다. 파일이 손상되었거나 처리하기 어려운 이미지일 수 있습니다. 다른 파일로 다시 시도하거나 이미지로 변환해 업로드해주세요.`,
      );

      const blob = await canvasToBlob(canvas, 'image/jpeg', option.quality);
      canvas.width = 1;
      canvas.height = 1;

      fallbackBlob = blob;
      if (blob.size <= MAX_UPLOAD_IMAGE_BYTES) {
        return new File([blob], `${type}_page_${pageIndexStr}.jpg`, { type: 'image/jpeg' });
      }
    }

    if (!fallbackBlob) {
      throw new Error('PDF 페이지 이미지를 만들 수 없습니다.');
    }

    return new File([fallbackBlob], `${type}_page_${pageIndexStr}.jpg`, { type: 'image/jpeg' });
  };

  const convertPdfToImages = async (file: File, type: UploadKind): Promise<File[]> => {
    // @ts-ignore
    const pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      throw new Error('PDF 변환 라이브러리가 로드되지 않았습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.');
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/pdf.worker.min.mjs';

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const imageFiles: File[] = [];

    setBatchStatusMessage(`PDF ${pdf.numPages}페이지를 업로드용 이미지로 변환하고 있습니다.`);

    for (let i = 1; i <= pdf.numPages; i++) {
      setBatchStatusMessage(`PDF 페이지를 변환하고 있습니다. (${i}/${pdf.numPages})`);
      const page = await pdf.getPage(i);
      imageFiles.push(await renderPdfPageToFile(page, type, i));
    }

    return imageFiles;
  };

  function stopCameraSession() {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (cameraVideoRef.current) {
      cameraVideoRef.current.srcObject = null;
    }
  }

  useEffect(() => {
    return () => {
      stopCameraSession();
    };
  }, []);

  const uploadSingleFile = async (file: File, type: UploadKind, replaceExisting = false): Promise<any> => {
    const uploadFile = await shrinkImageFileIfNeeded(file, MAX_UPLOAD_IMAGE_BYTES);
    const formData = new FormData();
    formData.append('file', uploadFile);
    formData.append('jobId', jobId);
    formData.append('type', type);
    formData.append('replaceExisting', replaceExisting ? 'true' : 'false');

    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      let errorMessage = '업로드에 실패했습니다.';

      if (res.status === 413) {
        errorMessage = '업로드 파일 용량이 너무 큽니다. 더 작은 용량의 이미지로 다시 시도해주세요.';
      } else {
        const errText = await res.text();
        try {
          const errData = JSON.parse(errText);
          errorMessage = errData.error || errorMessage;
        } catch {
          if (errText) errorMessage = errText.slice(0, 200);
        }
      }

      throw new Error(errorMessage);
    }

    return await res.json();
  };

  const setSequentialPreview = (file: File, type: UploadKind) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (type === 'cagi') {
        setCagiFile({ name: file.name, preview: reader.result as string });
      } else {
        setSatFile({ name: file.name, preview: reader.result as string });
      }
    };
    reader.readAsDataURL(file);
  };

  const uploadSequentialFile = async (file: File, type: UploadKind): Promise<boolean> => {
    setSequentialPreview(file, type);

    if (type === 'cagi') setIsCagiUploading(true);
    else setIsSatUploading(true);

    try {
      const data = await uploadSingleFile(file, type, true);
      onUploadSuccess(type, data.imageId, data.filename);
      if (type === 'cagi') setCagiCount(1);
      else setSatCount(1);
      return true;
    } catch (err: any) {
      alert(`파일 업로드 실패: ${err.message}`);
      return false;
    } finally {
      if (type === 'cagi') setIsCagiUploading(false);
      else setIsSatUploading(false);
    }
  };

  const processSelectedFile = async (file: File, type: UploadKind): Promise<void> => {
    setCameraError('');
    setCorrectionPreview(null);

    try {
      const image = await loadImageFile(file);

      try {
        const { width, height } = getImageDimensions(image);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        if (!context) {
          throw new Error('브라우저에서 이미지를 그릴 수 없습니다.');
        }

        canvas.width = width;
        canvas.height = height;
        context.drawImage(image, 0, 0, width, height);

        const cv = await withTimeout(loadOpenCv(), 5000, 'OpenCV.js load timed out.');
        const quad = detectDocumentQuad(cv, canvas);

        if (quad) {
          const template = type === 'cagi' ? cagiTemplate : satisfactionTemplate;
          const correctedCanvas = warpToRectangle(
            cv,
            canvas,
            quad,
            template.baseSize.width * PERSPECTIVE_CORRECTION_SCALE,
            template.baseSize.height * PERSPECTIVE_CORRECTION_SCALE,
          );

          setCorrectionPreview({
            canvas: correctedCanvas,
            step: type,
            previewSrc: correctedCanvas.toDataURL('image/jpeg', 0.88),
            source: 'file',
          });
          return;
        }
      } finally {
        if ('close' in image) {
          image.close();
        }
      }
    } catch {
      // Perspective correction is opportunistic; upload the original file unchanged on any correction failure.
    }

    await uploadSequentialFile(file, type);
  };

  const handleBatchFileChange = async (e: React.ChangeEvent<HTMLInputElement>, type: UploadKind) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsBatchProcessing(true);
    setBatchStatusMessage('파일을 확인하고 있습니다.');

    let filesToUpload: File[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type === 'application/pdf') {
          const extractedImages = await convertPdfToImages(file, type);
          filesToUpload = [...filesToUpload, ...extractedImages];
        } else if (file.type.startsWith('image/')) {
          filesToUpload.push(file);
        }
      }

      const total = filesToUpload.length;
      let successCount = 0;

      for (let i = 0; i < total; i++) {
        setBatchStatusMessage(`업로드 중입니다. (${i + 1}/${total})`);
        await uploadSingleFile(filesToUpload[i], type);
        successCount++;
      }

      if (type === 'cagi') {
        setCagiCount((prev) => prev + successCount);
      } else {
        setSatCount((prev) => prev + successCount);
      }
    } catch (err: any) {
      alert(`업로드 처리 중 오류가 발생했습니다: ${err.message}`);
    } finally {
      setIsBatchProcessing(false);
      setBatchStatusMessage('');
      if (e.target) e.target.value = '';
    }
  };

  const handleSequentialFileChange = async (e: React.ChangeEvent<HTMLInputElement>, type: UploadKind): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;

    await processSelectedFile(file, type);
    if (e.target) e.target.value = '';
  };

  const startCameraFlow = async () => {
    setCameraError('');
    setCorrectionPreview(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('이 브라우저는 웹 카메라 촬영을 지원하지 않습니다. 파일 업로드를 이용해주세요.');
      return;
    }

    if (!window.isSecureContext) {
      setCameraError('카메라 촬영은 HTTPS 또는 localhost 환경에서만 사용할 수 있습니다.');
      return;
    }

    setIsCameraStarting(true);
    try {
      let stream: MediaStream;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1600 },
            height: { ideal: 1200 },
          },
          audio: false,
        });
      } catch (firstErr: any) {
        if (firstErr?.name !== 'NotFoundError' && firstErr?.name !== 'OverconstrainedError') {
          throw firstErr;
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasVideoInput = devices.some((device) => device.kind === 'videoinput');

        if (!hasVideoInput) {
          throw new Error('CAMERA_DEVICE_NOT_FOUND');
        }

        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }

      cameraStreamRef.current = stream;
      setCameraFlow({ active: true, step: 'cagi', completed: [] });
      void loadOpenCv().catch(() => undefined);
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        setCameraError('카메라 권한이 거부되었습니다. 브라우저 권한을 허용한 뒤 다시 시도해주세요.');
      } else if (err?.message === 'CAMERA_DEVICE_NOT_FOUND' || err?.name === 'NotFoundError') {
        setCameraError('사용 가능한 카메라 장치를 찾지 못했습니다. 로컬 PC에 웹캠이 없으면 파일 업로드를 이용해주세요. 모바일에서는 HTTPS 환경에서 다시 확인해주세요.');
      } else if (err?.name === 'NotReadableError') {
        setCameraError('카메라가 다른 프로그램에서 사용 중입니다. 화상회의 앱이나 카메라 앱을 종료한 뒤 다시 시도해주세요.');
      } else {
        setCameraError(`카메라를 시작할 수 없습니다. 파일 업로드를 이용해주세요. (${err?.message || '알 수 없는 오류'})`);
      }
      stopCameraSession();
    } finally {
      setIsCameraStarting(false);
    }
  };

  const advanceCameraFlowAfterUpload = (step: UploadKind) => {
    if (step === 'cagi') {
      setCameraFlow({ active: true, step: 'satisfaction', completed: ['cagi'] });
    } else {
      stopCameraSession();
      setCameraFlow({ active: false, step: 'cagi', completed: ['cagi', 'satisfaction'] });
    }
  };

  const uploadCapturedCanvas = async (canvas: HTMLCanvasElement, step: UploadKind): Promise<boolean> => {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92);
    });

    if (!blob) {
      setCameraError('촬영 이미지를 저장할 수 없습니다. 다시 시도해주세요.');
      return false;
    }

    const file = new File([blob], `${step}_${Date.now()}.jpg`, { type: 'image/jpeg' });
    const uploaded = await uploadSequentialFile(file, step);
    if (!uploaded) return false;

    advanceCameraFlowAfterUpload(step);
    return true;
  };

  const uploadCorrectedFileCanvas = async (canvas: HTMLCanvasElement, type: UploadKind): Promise<boolean> => {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92);
    });

    if (!blob) {
      setCameraError('보정된 이미지를 저장할 수 없습니다. 다시 선택해주세요.');
      return false;
    }

    const file = new File([blob], `${type}_${Date.now()}.jpg`, { type: 'image/jpeg' });
    return await uploadSequentialFile(file, type);
  };

  const confirmCorrectionPreview = async () => {
    if (!correctionPreview) return;

    const uploaded = correctionPreview.source === 'camera'
      ? await uploadCapturedCanvas(correctionPreview.canvas, correctionPreview.step)
      : await uploadCorrectedFileCanvas(correctionPreview.canvas, correctionPreview.step);

    if (uploaded) {
      setCorrectionPreview(null);
    }
  };

  const retakeCorrectionPreview = () => {
    setCorrectionPreview(null);
    setCameraError('');
  };

  const captureCurrentFrame = async () => {
    if (isCapturing || isCagiUploading || isSatUploading) return;

    const video = cameraVideoRef.current;
    const canvas = cameraCanvasRef.current;
    if (!video || !canvas || !cameraStreamRef.current) {
      setCameraError('카메라 화면을 찾을 수 없습니다. 다시 촬영을 시작해주세요.');
      return;
    }

    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      setCameraError('카메라 화면이 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.');
      return;
    }

    setIsCapturing(true);
    try {
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 960;
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext('2d');
      if (!context) {
        setCameraError('촬영 이미지를 만들 수 없습니다. 브라우저를 다시 시도해주세요.');
        return;
      }

      context.drawImage(video, 0, 0, width, height);

      try {
        const cv = await withTimeout(loadOpenCv(), 5000, 'OpenCV.js load timed out.');
        const quad = detectDocumentQuad(cv, canvas);

        if (quad) {
          const template = cameraFlow.step === 'cagi' ? cagiTemplate : satisfactionTemplate;
          const correctedCanvas = warpToRectangle(
            cv,
            canvas,
            quad,
            template.baseSize.width * PERSPECTIVE_CORRECTION_SCALE,
            template.baseSize.height * PERSPECTIVE_CORRECTION_SCALE,
          );

          setCorrectionPreview({
            canvas: correctedCanvas,
            step: cameraFlow.step,
            previewSrc: correctedCanvas.toDataURL('image/jpeg', 0.88),
            source: 'camera',
          });
          return;
        }
      } catch {
        // Perspective correction is an opportunistic camera-only enhancement.
      }

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.92);
      });

      if (!blob) {
        setCameraError('촬영 이미지를 저장할 수 없습니다. 다시 시도해주세요.');
        return;
      }

      const file = new File([blob], `${cameraFlow.step}_${Date.now()}.jpg`, { type: 'image/jpeg' });
      const uploaded = await uploadSequentialFile(file, cameraFlow.step);
      if (!uploaded) return;

      advanceCameraFlowAfterUpload(cameraFlow.step);
    } catch (err: any) {
      setCameraError(`촬영 중 오류가 발생했습니다. 다시 시도해주세요. (${err?.message || '알 수 없는 오류'})`);
    } finally {
      setIsCapturing(false);
    }
  };

  const cancelCameraFlow = () => {
    stopCameraSession();
    setCameraFlow({ active: false, step: 'cagi', completed: [] });
    setCameraError('');
    setCorrectionPreview(null);
  };

  const handleResetBatch = async () => {
    setIsBatchProcessing(true);
    setBatchStatusMessage('?낅줈???뚯씪???뺣━?섍퀬 ?덉뒿?덈떎.');

    try {
      const res = await fetch('/api/jobs/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, scope: 'uploads' }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || '?뚯씪 ?뺣━ ?ㅽ뙣');
      }

      setCagiCount(0);
      setSatCount(0);
      setCagiFile(null);
      setSatFile(null);
      setCameraError('');
    } catch (err: any) {
      alert(`?낅줈??珥덇린??以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎: ${err.message}`);
    } finally {
      setIsBatchProcessing(false);
      setBatchStatusMessage('');
    }
  };

  const isMismatch = cagiCount !== satCount;
  const cameraStepLabel = cameraFlow.step === 'cagi' ? '선별검사지 촬영' : '만족도조사 촬영';
  const cameraStepDescription = cameraFlow.step === 'cagi'
    ? '종이 전체가 화면 안에 들어오도록 맞춘 뒤 선별검사지 앞면을 촬영해주세요.'
    : '같은 학생의 만족도조사 뒷면을 촬영해주세요. 문항1~10 응답 영역이 잘 보이게 맞춰주세요.';
  const cameraCorrectionPreview = correctionPreview?.source === 'camera' ? correctionPreview : null;
  const fileCorrectionPreview = correctionPreview?.source === 'file' ? correctionPreview : null;

  const renderUploadBox = ({
    type,
    title,
    description,
    count,
    file,
    uploading,
    inputRef,
    multiple,
    onChange,
  }: {
    type: UploadKind;
    title: string;
    description: string;
    count: number;
    file?: { name: string; preview: string } | null;
    uploading: boolean;
    inputRef: React.RefObject<HTMLInputElement>;
    multiple: boolean;
    onChange: (e: React.ChangeEvent<HTMLInputElement>, type: UploadKind) => void;
  }) => (
    <div
      className="panel"
      style={{
        minHeight: 210,
        padding: 22,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 18,
        borderStyle: count > 0 ? 'solid' : 'dashed',
        borderColor: count > 0 ? 'var(--brand-primary)' : 'var(--border-medium)',
      }}
    >
      <input
        type="file"
        ref={inputRef}
        style={{ display: 'none' }}
        accept={multiple ? 'image/*,application/pdf' : 'image/*'}
        multiple={multiple}
        onChange={(e) => onChange(e, type)}
      />
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <strong style={{ fontSize: 17 }}>{title}</strong>
          {count > 0 && (
            <span style={{
              border: '1px solid var(--brand-soft-border)',
              color: 'var(--brand-primary)',
              background: 'var(--brand-soft)',
              borderRadius: 999,
              padding: '4px 10px',
              fontSize: 13,
              fontWeight: 700,
              whiteSpace: 'nowrap',
            }}>
              {count}장
            </span>
          )}
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 }}>{description}</p>
        {file && (
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
            <img
              src={file.preview}
              alt=""
              style={{ width: 54, height: 54, objectFit: 'cover', border: '1px solid var(--border-subtle)' }}
            />
            <span style={{ fontSize: 14, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{file.name}</span>
          </div>
        )}
      </div>
      <button
        className="btn-secondary"
        type="button"
        onClick={() => !uploading && !isBatchProcessing && inputRef.current?.click()}
        disabled={uploading || isBatchProcessing}
      >
        {uploading ? '업로드 중' : count > 0 ? '다시 업로드' : '파일 선택'}
      </button>
    </div>
  );

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="notice">
        <strong>순서 확인:</strong> 앞면과 뒷면을 따로 올리는 경우 두 묶음의 학생 순서가 같아야 합니다.
        장수가 다르면 분석을 시작할 수 없습니다.
      </div>
      {cameraError && <div className="error-box">{cameraError}</div>}

      {mode === 'sequential' ? (
        cameraFlow.active ? (
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
              <div>
                <p className="section-kicker">Camera Capture</p>
                <h2 style={{ fontSize: 24, marginBottom: 8 }}>{cameraStepLabel}</h2>
                <p style={{ color: 'var(--text-muted)', lineHeight: 1.65 }}>{cameraStepDescription}</p>
              </div>
              <span className="status-pill">{cameraFlow.step === 'cagi' ? '1 / 2' : '2 / 2'}</span>
            </div>

            {cameraCorrectionPreview && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <img
                  src={cameraCorrectionPreview.previewSrc}
                  alt="보정된 촬영 미리보기"
                  style={{
                    width: '100%',
                    maxHeight: 520,
                    objectFit: 'contain',
                    background: '#111827',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                  }}
                />
              </div>
            )}

            <div className="camera-live-layout" style={cameraCorrectionPreview ? { display: 'none' } : undefined}>
              <div className="camera-live-frame">
                <video
                  ref={cameraVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="camera-live-video"
                  aria-label="카메라 미리보기"
                />
                <div className="camera-live-overlay" aria-hidden="true">
                  <span>{cameraStepLabel}</span>
                </div>
              </div>
              <canvas ref={cameraCanvasRef} style={{ display: 'none' }} />
              <ul>
                <li>종이의 네 모서리가 모두 보이게 촬영합니다.</li>
                <li>그림자와 흔들림을 줄이고 정면에서 촬영합니다.</li>
                <li>체크 표시가 작게 보이지 않도록 화면을 가득 채웁니다.</li>
              </ul>
            </div>

            {cameraCorrectionPreview && (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={retakeCorrectionPreview}
                  disabled={isCagiUploading || isSatUploading}
                >
                  다시 촬영
                </button>
                <button
                  className="btn-primary capture-action-button"
                  type="button"
                  onClick={confirmCorrectionPreview}
                  disabled={isCagiUploading || isSatUploading}
                >
                  {isCagiUploading || isSatUploading ? '업로드 중' : '이대로 사용'}
                </button>
              </div>
            )}

            <div style={{ display: cameraCorrectionPreview ? 'none' : 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                className="btn-secondary"
                type="button"
                onClick={cancelCameraFlow}
                disabled={isCapturing || isCagiUploading || isSatUploading}
              >
                촬영 취소
              </button>
              <button
                className="btn-primary capture-action-button"
                type="button"
                onClick={captureCurrentFrame}
                disabled={isCapturing || isCagiUploading || isSatUploading}
              >
                {isCagiUploading || isSatUploading
                  ? '업로드 중'
                  : isCapturing
                    ? '처리 중'
                    : `${cameraStepLabel}하기`}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="panel panel-pad capture-start-panel">
              <div>
                <p className="section-kicker">Mobile Capture</p>
                <h2 style={{ fontSize: 22, marginBottom: 6 }}>카메라로 2장 촬영하기</h2>
                <p style={{ color: 'var(--text-muted)', lineHeight: 1.6, fontSize: 14 }}>
                  선별검사지와 만족도조사를 각각 1장씩 촬영합니다. 2장 촬영이 끝나면 원래 화면으로 돌아와 인식 절차로 이어집니다.
                </p>
              </div>
              <button className="btn-primary capture-start-button" type="button" onClick={startCameraFlow} disabled={isCameraStarting}>
                {isCameraStarting ? '준비중' : '촬영하기'}
              </button>
            </div>
            {fileCorrectionPreview && (
              <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <img
                  src={fileCorrectionPreview.previewSrc}
                  alt="보정된 업로드 미리보기"
                  style={{
                    width: '100%',
                    maxHeight: 520,
                    objectFit: 'contain',
                    background: '#111827',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                  }}
                />
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={retakeCorrectionPreview}
                    disabled={isCagiUploading || isSatUploading}
                  >
                    다시 선택
                  </button>
                  <button
                    className="btn-primary capture-action-button"
                    type="button"
                    onClick={confirmCorrectionPreview}
                    disabled={isCagiUploading || isSatUploading}
                  >
                    {isCagiUploading || isSatUploading ? '업로드 중' : '이대로 사용'}
                  </button>
                </div>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
              {renderUploadBox({
                type: 'cagi',
                title: '선별검사지 파일 업로드',
                description: '촬영 대신 저장된 선별검사지 이미지를 직접 업로드할 수 있습니다.',
                count: cagiCount,
                file: cagiFile,
                uploading: isCagiUploading,
                inputRef: cagiInputRef,
                multiple: false,
                onChange: handleSequentialFileChange,
              })}
              {renderUploadBox({
                type: 'satisfaction',
                title: '만족도조사 파일 업로드',
                description: '촬영 대신 저장된 만족도조사 이미지를 직접 업로드할 수 있습니다.',
                count: satCount,
                file: satFile,
                uploading: isSatUploading,
                inputRef: satInputRef,
                multiple: false,
                onChange: handleSequentialFileChange,
              })}
            </div>
          </div>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
            {renderUploadBox({
              type: 'cagi',
              title: '1단계: 선별검사지 묶음',
              description: '앞면 이미지 여러 장 또는 선별검사지 PDF 1개를 업로드합니다.',
              count: cagiCount,
              uploading: isBatchProcessing,
              inputRef: cagiInputRef,
              multiple: true,
              onChange: handleBatchFileChange,
            })}
            {renderUploadBox({
              type: 'satisfaction',
              title: '2단계: 만족도조사 묶음',
              description: '뒷면 이미지 여러 장 또는 만족도조사 PDF 1개를 업로드합니다.',
              count: satCount,
              uploading: isBatchProcessing,
              inputRef: satInputRef,
              multiple: true,
              onChange: handleBatchFileChange,
            })}
          </div>

          {(cagiCount > 0 || satCount > 0 || isBatchProcessing) && (
            <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <strong>업로드 집계 현황</strong>
                <button className="btn-secondary" type="button" onClick={handleResetBatch} disabled={isBatchProcessing}>
                  화면 초기화
                </button>
              </div>
              <div style={{ display: 'flex', gap: 24, color: 'var(--text-secondary)', fontSize: 15 }}>
                <span>선별검사지: <strong style={{ color: 'var(--text-primary)' }}>{cagiCount}장</strong></span>
                <span>만족도조사: <strong style={{ color: 'var(--text-primary)' }}>{satCount}장</strong></span>
              </div>
              {cagiCount > 0 && satCount > 0 && isMismatch && (
                <div className="error-box">
                  장수가 일치하지 않습니다. 선별검사지 {cagiCount}장, 만족도조사 {satCount}장입니다.
                  누락되거나 초과된 사진이 있는지 확인해주세요.
                </div>
              )}
              {isBatchProcessing ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 14 }}>
                  <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
                  {batchStatusMessage}
                </div>
              ) : (
                cagiCount > 0 && satCount > 0 && (
                  <button className="btn-primary" type="button" disabled={isMismatch} onClick={onAnalyzeTrigger}>
                    전체 설문지 인식 시작
                  </button>
                )
              )}
            </div>
          )}
        </div>
      )}

      <style>{`
        .spinner {
          width: 30px;
          height: 30px;
          border: 3px solid var(--border-subtle);
          border-top-color: var(--brand-primary);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @media (max-width: 760px) {
          section div[style*="grid-template-columns"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </section>
  );
}
