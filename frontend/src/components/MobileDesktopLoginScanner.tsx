'use client';

import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  Camera,
  Check,
  ChevronRight,
  Flashlight,
  Laptop,
  LoaderCircle,
  ScanLine,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  clearPendingDesktopLoginApproval,
  parseDesktopLoginQr,
  savePendingDesktopLoginApproval,
  type DesktopLoginApprovalReference,
} from '@/lib/desktopLogin';
import styles from './MobileDesktopLoginScanner.module.css';

type ScannerModule = typeof import('@capacitor-mlkit/barcode-scanning');

export interface MobileDesktopLoginPreview {
  sessionId: string;
  clientName: string;
  verificationCode: string;
  expiresAt: string;
  status:
    | 'pending'
    | 'approved'
    | 'consumed'
    | 'denied'
    | 'cancelled'
    | 'expired'
    | 'account_unavailable';
}

export type MobileDesktopLoginDecision = 'approve' | 'deny';

interface MobileDesktopLoginScannerProps {
  isAuthenticated: boolean;
  currentAccountLabel?: string;
  onPreview: (
    reference: DesktopLoginApprovalReference,
  ) => Promise<MobileDesktopLoginPreview>;
  onDecision: (
    reference: DesktopLoginApprovalReference,
    decision: MobileDesktopLoginDecision,
  ) => Promise<void>;
  onAuthenticationRequired: (
    reference: DesktopLoginApprovalReference,
  ) => void;
  initialReference?: DesktopLoginApprovalReference | null;
  onInitialReferenceLoaded?: () => void;
  onDismiss?: () => void;
  onApproved?: () => void;
  label?: string;
  variant?: 'primary' | 'secondary' | 'settings';
  className?: string;
}

type ViewState =
  | 'closed'
  | 'starting'
  | 'scanning'
  | 'previewing'
  | 'confirm'
  | 'submitting'
  | 'approved'
  | 'permission-denied'
  | 'unsupported'
  | 'expired'
  | 'error';

const SCANNER_ACTIVE_CLASS = 'zhicui-desktop-login-scanner-active';

let scannerModulePromise: Promise<ScannerModule> | null = null;

function loadScannerModule(): Promise<ScannerModule> {
  scannerModulePromise ??= import('@capacitor-mlkit/barcode-scanning');
  return scannerModulePromise;
}

function isPermissionGranted(permission: string): boolean {
  return permission === 'granted' || permission === 'limited';
}

function permissionNeedsPrompt(permission: string): boolean {
  return permission === 'prompt' || permission === 'prompt-with-rationale';
}

function friendlyScanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/permission|denied|camera/i.test(message)) {
    return '无法使用相机，请在系统设置中允许知萃访问相机';
  }
  return '扫码没有成功，请关闭后重试';
}

function statusError(status: MobileDesktopLoginPreview['status']): string {
  switch (status) {
    case 'expired':
      return '这个登录码已过期，请在电脑上刷新二维码';
    case 'denied':
      return '这个登录请求已被拒绝';
    case 'cancelled':
      return '电脑已取消这次登录';
    case 'approved':
      return '这次登录已经确认，请查看电脑';
    case 'consumed':
      return '这个登录码已经使用过了';
    case 'account_unavailable':
      return '电脑登录关联的账号当前不可用';
    default:
      return '这个登录码当前不可用';
  }
}

function secondsUntil(value: string): number {
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function isNativeAndroidScanner(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export default function MobileDesktopLoginScanner({
  isAuthenticated,
  currentAccountLabel,
  onPreview,
  onDecision,
  onAuthenticationRequired,
  initialReference = null,
  onInitialReferenceLoaded,
  onDismiss,
  onApproved,
  label = '扫码登录电脑',
  variant = 'secondary',
  className = '',
}: MobileDesktopLoginScannerProps) {
  const [nativeAndroid, setNativeAndroid] = useState(false);
  const [viewState, setViewState] = useState<ViewState>('closed');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<MobileDesktopLoginPreview | null>(null);
  const [reference, setReference] = useState<DesktopLoginApprovalReference | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [torchEnabled, setTorchEnabled] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scannerModuleRef = useRef<ScannerModule | null>(null);
  const listenersRef = useRef<PluginListenerHandle[]>([]);
  const scannerStartedRef = useRef(false);
  const scanGenerationRef = useRef(0);
  const processingRef = useRef(false);
  const mountedRef = useRef(true);
  const lastInvalidCodeRef = useRef('');
  const lastInitialReferenceRef = useRef('');

  useEffect(() => {
    setNativeAndroid(isNativeAndroidScanner());
  }, []);

  const restoreWebView = useCallback(() => {
    document.documentElement.classList.remove(SCANNER_ACTIVE_CLASS);
    document.body.classList.remove(SCANNER_ACTIVE_CLASS);
  }, []);

  const stopScanner = useCallback(async () => {
    lastInvalidCodeRef.current = '';

    const listeners = listenersRef.current.splice(0);
    await Promise.allSettled(listeners.map((listener) => listener.remove()));

    const scannerModule = scannerModuleRef.current;
    if (scannerStartedRef.current && scannerModule) {
      scannerStartedRef.current = false;
      await scannerModule.BarcodeScanner.stopScan().catch(() => undefined);
    }
    if (mountedRef.current) setTorchEnabled(false);
    restoreWebView();
  }, [restoreWebView]);

  const closeOverlay = useCallback(async (notifyDismiss = true) => {
    scanGenerationRef.current += 1;
    processingRef.current = false;
    await stopScanner();
    if (!mountedRef.current) return;
    setViewState('closed');
    setMessage('');
    setPreview(null);
    setReference(null);
    if (notifyDismiss) onDismiss?.();
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onDismiss, stopScanner]);

  const showFailure = useCallback(async (
    nextState: Extract<ViewState, 'error' | 'permission-denied' | 'unsupported'>,
    nextMessage: string,
    expectedGeneration?: number,
  ) => {
    if (
      expectedGeneration !== undefined
      && expectedGeneration !== scanGenerationRef.current
    ) return;
    scanGenerationRef.current += 1;
    processingRef.current = false;
    await stopScanner();
    if (!mountedRef.current) return;
    setMessage(nextMessage);
    setViewState(nextState);
  }, [stopScanner]);

  const reviewReference = useCallback(async (
    parsed: DesktopLoginApprovalReference,
  ) => {
    if (processingRef.current) return;
    const reviewGeneration = scanGenerationRef.current + 1;
    scanGenerationRef.current = reviewGeneration;
    processingRef.current = true;
    setMessage('正在核对登录请求…');
    setViewState('previewing');
    window.requestAnimationFrame(() => closeRef.current?.focus());
    await stopScanner();
    if (
      reviewGeneration !== scanGenerationRef.current
      || !mountedRef.current
    ) return;

    try {
      const nextPreview = await onPreview(parsed);
      if (
        reviewGeneration !== scanGenerationRef.current
        || !mountedRef.current
      ) return;
      if (nextPreview.status !== 'pending') {
        setPreview(nextPreview);
        setMessage(statusError(nextPreview.status));
        setViewState(nextPreview.status === 'expired' ? 'expired' : 'error');
        return;
      }
      const nextRemaining = secondsUntil(nextPreview.expiresAt);
      if (nextRemaining <= 0) {
        setMessage('这个登录码已过期，请在电脑上刷新二维码');
        setViewState('expired');
        return;
      }
      setReference(parsed);
      setPreview(nextPreview);
      setRemainingSeconds(nextRemaining);
      setMessage('');
      setViewState('confirm');
    } catch (error) {
      if (
        reviewGeneration !== scanGenerationRef.current
        || !mountedRef.current
      ) return;
      setMessage(error instanceof Error ? error.message : '无法核对登录请求，请重试');
      setViewState('error');
    } finally {
      if (reviewGeneration === scanGenerationRef.current) {
        processingRef.current = false;
      }
    }
  }, [onPreview, stopScanner]);

  const handleRawCode = useCallback(async (rawValue: string) => {
    if (processingRef.current) return;

    let parsed: DesktopLoginApprovalReference | null = null;
    try {
      parsed = parseDesktopLoginQr(rawValue);
    } catch {
      parsed = null;
    }

    if (!parsed) {
      if (lastInvalidCodeRef.current !== rawValue) {
        lastInvalidCodeRef.current = rawValue;
        setMessage('这不是知萃电脑登录码，请对准电脑上的二维码');
      }
      return;
    }

    await reviewReference(parsed);
  }, [reviewReference]);

  const startScanner = useCallback(async () => {
    if (!isNativeAndroidScanner()) {
      setMessage('请在知萃 Android 客户端中使用扫码登录');
      setViewState('unsupported');
      return;
    }

    const generation = scanGenerationRef.current + 1;
    scanGenerationRef.current = generation;
    processingRef.current = false;
    lastInvalidCodeRef.current = '';
    setPreview(null);
    setReference(null);
    setMessage('正在启动相机…');
    setViewState('starting');
    window.requestAnimationFrame(() => closeRef.current?.focus());

    try {
      const scannerModule = await loadScannerModule();
      if (generation !== scanGenerationRef.current || !mountedRef.current) return;
      scannerModuleRef.current = scannerModule;

      const support = await scannerModule.BarcodeScanner.isSupported();
      if (generation !== scanGenerationRef.current || !mountedRef.current) return;
      if (!support.supported) {
        await showFailure(
          'unsupported',
          '当前设备没有可用相机，请使用账号密码登录',
          generation,
        );
        return;
      }

      let { camera } = await scannerModule.BarcodeScanner.checkPermissions();
      if (generation !== scanGenerationRef.current || !mountedRef.current) return;
      if (permissionNeedsPrompt(camera)) {
        ({ camera } = await scannerModule.BarcodeScanner.requestPermissions());
      }
      if (generation !== scanGenerationRef.current || !mountedRef.current) return;
      if (!isPermissionGranted(camera)) {
        await showFailure(
          'permission-denied',
          '需要相机权限才能扫码。你仍可继续使用账号密码登录',
          generation,
        );
        return;
      }

      const scannedListener = await scannerModule.BarcodeScanner.addListener(
        'barcodesScanned',
        (event) => {
          if (
            generation !== scanGenerationRef.current
            || !scannerStartedRef.current
            || !mountedRef.current
          ) return;
          const barcode = event.barcodes.find((item) => (
            item.format === scannerModule.BarcodeFormat.QrCode
            && Boolean(item.rawValue || item.displayValue)
          ));
          if (barcode) void handleRawCode(barcode.rawValue || barcode.displayValue);
        },
      );
      const errorListener = await scannerModule.BarcodeScanner.addListener(
        'scanError',
        (event) => {
          if (
            generation !== scanGenerationRef.current
            || !scannerStartedRef.current
            || !mountedRef.current
          ) return;
          void showFailure('error', friendlyScanError(event.message), generation);
        },
      );
      if (generation !== scanGenerationRef.current || !mountedRef.current) {
        await Promise.allSettled([scannedListener.remove(), errorListener.remove()]);
        return;
      }
      listenersRef.current.push(scannedListener, errorListener);

      document.documentElement.classList.add(SCANNER_ACTIVE_CLASS);
      document.body.classList.add(SCANNER_ACTIVE_CLASS);
      scannerStartedRef.current = true;
      await scannerModule.BarcodeScanner.startScan({
        formats: [scannerModule.BarcodeFormat.QrCode],
        lensFacing: scannerModule.LensFacing.Back,
        resolution: scannerModule.Resolution['1280x720'],
      });
      if (generation !== scanGenerationRef.current || !mountedRef.current) {
        await stopScanner();
        return;
      }
      setMessage('对准电脑上的知萃登录码');
      setViewState('scanning');
    } catch (error) {
      await showFailure('error', friendlyScanError(error), generation);
    }
  }, [handleRawCode, showFailure, stopScanner]);

  const openScanner = useCallback(() => {
    void startScanner();
  }, [startScanner]);

  const toggleTorch = useCallback(async () => {
    const scannerModule = scannerModuleRef.current;
    if (!scannerStartedRef.current || !scannerModule) return;
    try {
      const available = await scannerModule.BarcodeScanner.isTorchAvailable();
      if (!available.available) {
        setMessage('当前设备不支持闪光灯');
        return;
      }
      await scannerModule.BarcodeScanner.toggleTorch();
      const result = await scannerModule.BarcodeScanner.isTorchEnabled();
      setTorchEnabled(result.enabled);
    } catch {
      setMessage('闪光灯暂时不可用');
    }
  }, []);

  const openCameraSettings = useCallback(async () => {
    try {
      const scannerModule = scannerModuleRef.current ?? await loadScannerModule();
      await scannerModule.BarcodeScanner.openSettings();
    } catch {
      setMessage('无法打开系统设置，请手动在应用权限中开启相机');
    }
  }, []);

  const continueAfterAuthentication = useCallback(() => {
    if (!reference) return;
    savePendingDesktopLoginApproval(reference, preview?.expiresAt);
    onAuthenticationRequired(reference);
    void closeOverlay(false);
  }, [closeOverlay, onAuthenticationRequired, preview?.expiresAt, reference]);

  const submitDecision = useCallback(async (decision: MobileDesktopLoginDecision) => {
    if (!reference || !preview || processingRef.current) return;
    const decisionGeneration = scanGenerationRef.current + 1;
    scanGenerationRef.current = decisionGeneration;
    processingRef.current = true;
    setMessage(decision === 'approve' ? '正在确认登录…' : '正在拒绝登录…');
    setViewState('submitting');
    try {
      await onDecision(reference, decision);
      if (
        decisionGeneration !== scanGenerationRef.current
        || !mountedRef.current
      ) return;
      clearPendingDesktopLoginApproval();
      if (decision === 'approve') {
        setMessage('电脑正在登录');
        setViewState('approved');
        onApproved?.();
        return;
      }
      await closeOverlay();
    } catch (error) {
      if (
        decisionGeneration !== scanGenerationRef.current
        || !mountedRef.current
      ) return;
      setMessage(error instanceof Error ? error.message : '操作没有成功，请重试');
      setViewState('confirm');
    } finally {
      if (decisionGeneration === scanGenerationRef.current) {
        processingRef.current = false;
      }
    }
  }, [closeOverlay, onApproved, onDecision, preview, reference]);

  useEffect(() => {
    if (!nativeAndroid || !isAuthenticated || !initialReference || viewState !== 'closed') {
      return;
    }
    const referenceKey = `${initialReference.sessionId}.${initialReference.approvalToken}`;
    if (lastInitialReferenceRef.current === referenceKey) return;
    lastInitialReferenceRef.current = referenceKey;
    clearPendingDesktopLoginApproval();
    onInitialReferenceLoaded?.();
    void reviewReference(initialReference);
  }, [
    initialReference,
    isAuthenticated,
    nativeAndroid,
    onInitialReferenceLoaded,
    reviewReference,
    viewState,
  ]);

  useEffect(() => {
    if (viewState !== 'confirm' || !preview) return;
    const refresh = () => {
      const seconds = secondsUntil(preview.expiresAt);
      setRemainingSeconds(seconds);
      if (seconds <= 0) {
        setMessage('这个登录码已过期，请在电脑上刷新二维码');
        setViewState('expired');
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [preview, viewState]);

  useEffect(() => {
    if (viewState === 'closed') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void closeOverlay();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeOverlay, viewState]);

  useEffect(() => {
    if (viewState !== 'scanning') return;
    let disposed = false;
    let appStateListener: PluginListenerHandle | null = null;

    void import('@capacitor/app')
      .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) void closeOverlay();
      }))
      .then((listener) => {
        if (disposed) void listener.remove();
        else appStateListener = listener;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      if (appStateListener) void appStateListener.remove();
    };
  }, [closeOverlay, viewState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scanGenerationRef.current += 1;
      processingRef.current = false;
      void stopScanner();
    };
  }, [stopScanner]);

  if (!nativeAndroid) return null;

  const cameraVisible = viewState === 'scanning';
  const overlayOpen = viewState !== 'closed';

  return (
    <div className={`${styles.host} ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${styles[variant]}`}
        onClick={openScanner}
      >
        <span className={styles.triggerIcon} aria-hidden="true"><ScanLine size={19} /></span>
        <span>{label}</span>
        {variant === 'settings' ? <ChevronRight size={18} aria-hidden="true" /> : null}
      </button>

      <div
        className={`${styles.overlay} ${overlayOpen ? styles.overlayOpen : ''} ${cameraVisible ? styles.cameraMode : styles.panelMode}`}
        role="dialog"
        aria-modal={overlayOpen ? 'true' : undefined}
        aria-label="扫码登录电脑"
        aria-hidden={!overlayOpen}
      >
        <header className={styles.scannerHeader}>
          <button
            ref={closeRef}
            type="button"
            className={styles.iconButton}
            onClick={() => void closeOverlay()}
            aria-label="关闭扫码登录"
          >
            <X size={22} />
          </button>
          <strong>扫码登录电脑</strong>
          {viewState === 'scanning' ? (
            <button
              type="button"
              className={`${styles.iconButton} ${torchEnabled ? styles.iconButtonActive : ''}`}
              onClick={() => void toggleTorch()}
              aria-label={torchEnabled ? '关闭闪光灯' : '打开闪光灯'}
              aria-pressed={torchEnabled}
            >
              <Flashlight size={21} />
            </button>
          ) : <span className={styles.headerSpacer} aria-hidden="true" />}
        </header>

        {cameraVisible ? (
          <div className={styles.cameraStage}>
            <div className={`${styles.cameraShade} ${styles.shadeTop}`} />
            <div className={`${styles.cameraShade} ${styles.shadeLeft}`} />
            <div className={styles.scanFrame} aria-hidden="true">
              <span className={styles.cornerTopLeft} />
              <span className={styles.cornerTopRight} />
              <span className={styles.cornerBottomLeft} />
              <span className={styles.cornerBottomRight} />
              {viewState === 'scanning' ? <span className={styles.scanBeam} /> : null}
            </div>
            <div className={`${styles.cameraShade} ${styles.shadeRight}`} />
            <div className={`${styles.cameraShade} ${styles.shadeBottom}`} />
          </div>
        ) : (
          <main className={styles.panelContent}>
            {viewState === 'confirm' && preview ? (
              <section className={styles.confirmPanel} aria-live="polite">
                <div className={styles.deviceIcon} aria-hidden="true"><Laptop size={28} /></div>
                <p className={styles.kicker}>登录确认</p>
                <h2>{preview.clientName || 'Windows 客户端'}</h2>
                <p className={styles.confirmLead}>确认是你正在操作的电脑</p>
                <div className={styles.verificationCode} aria-label={`校验码 ${preview.verificationCode}`}>
                  {preview.verificationCode.split('').map((digit, index) => (
                    <span key={`${digit}-${index}`}>{digit}</span>
                  ))}
                </div>
                <div className={styles.confirmMeta}>
                  <span>{isAuthenticated ? `账号：${currentAccountLabel || '当前账号'}` : '登录后使用当前账号确认'}</span>
                  <span>剩余 {formatRemaining(remainingSeconds)}</span>
                </div>
                {isAuthenticated ? (
                  <div className={styles.actionStack}>
                    <button
                      type="button"
                      className={styles.primaryAction}
                      onClick={() => void submitDecision('approve')}
                    >
                      <ShieldCheck size={19} />
                      确认登录
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryAction}
                      onClick={() => void submitDecision('deny')}
                    >
                      拒绝登录
                    </button>
                  </div>
                ) : (
                  <div className={styles.actionStack}>
                    <button
                      type="button"
                      className={styles.primaryAction}
                      onClick={continueAfterAuthentication}
                    >
                      登录后继续
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryAction}
                      onClick={() => void closeOverlay()}
                    >
                      取消
                    </button>
                  </div>
                )}
              </section>
            ) : null}

            {viewState === 'submitting' ? (
              <section className={styles.statePanel} aria-live="polite" aria-busy="true">
                <LoaderCircle className={styles.spin} size={28} aria-hidden="true" />
                <h2>{message}</h2>
                <p>请保持当前页面打开</p>
              </section>
            ) : null}

            {viewState === 'starting' || viewState === 'previewing' ? (
              <section className={styles.statePanel} aria-live="polite" aria-busy="true">
                <LoaderCircle className={styles.spin} size={28} aria-hidden="true" />
                <h2>{message}</h2>
                <p>{viewState === 'starting' ? '首次使用可能需要授权相机' : '请稍候'}</p>
              </section>
            ) : null}

            {viewState === 'approved' ? (
              <section className={styles.statePanel} aria-live="polite">
                <span className={styles.successIcon} aria-hidden="true"><Check size={27} /></span>
                <h2>已确认登录</h2>
                <p>电脑会自动进入知萃</p>
                <button type="button" className={styles.primaryAction} onClick={() => void closeOverlay()}>
                  完成
                </button>
              </section>
            ) : null}

            {viewState === 'permission-denied' ? (
              <section className={styles.statePanel} aria-live="polite">
                <span className={styles.neutralIcon} aria-hidden="true"><Camera size={26} /></span>
                <h2>需要相机权限</h2>
                <p>{message}</p>
                <button type="button" className={styles.primaryAction} onClick={() => void openCameraSettings()}>
                  <Settings size={18} />
                  打开系统设置
                </button>
                <button type="button" className={styles.secondaryAction} onClick={() => void closeOverlay()}>
                  暂不用
                </button>
              </section>
            ) : null}

            {viewState === 'error' || viewState === 'expired' || viewState === 'unsupported' ? (
              <section className={styles.statePanel} aria-live="polite">
                <span className={styles.neutralIcon} aria-hidden="true"><ScanLine size={27} /></span>
                <h2>{viewState === 'expired' ? '登录码已过期' : '无法完成扫码'}</h2>
                <p>{message}</p>
                {viewState !== 'unsupported' ? (
                  <button type="button" className={styles.primaryAction} onClick={openScanner}>
                    重新扫描
                  </button>
                ) : null}
                <button type="button" className={styles.secondaryAction} onClick={() => void closeOverlay()}>
                  关闭
                </button>
              </section>
            ) : null}
          </main>
        )}

        {cameraVisible ? (
          <footer className={styles.scannerFooter} aria-live="polite">
            <ScanLine size={20} aria-hidden="true" />
            <div>
              <strong>{message}</strong>
              <span>仅在本机识别，画面不上传</span>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
