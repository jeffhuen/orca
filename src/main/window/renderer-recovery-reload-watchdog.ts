import { is } from '@electron-toolkit/utils'
import type { BrowserWindow } from 'electron'
import { isSystemSessionEnding } from '../crash-reporting/expected-teardown-state'
import type { CreateMainWindowOptions, MainWindowLoadObserver } from './main-window-contracts'
import { mainWindowLoadErrorCode } from './main-window-load-error-code'

// Why 45s of *silence*: in the field a recovery reload that lands does so in 0.3-2s (slowest observed 30.4s),
// while a stalled one never lands at all — silent for up to 4h until the user force-quits. The budget measures
// time since the last observed milestone, not since issue, so a progressing load is never called stalled.
export const RENDERER_RECOVERY_LOAD_TIMEOUT_MS = 45_000
// Why: the dev load comes from Vite, whose cold start (or restart) legitimately outruns any packaged-load budget.
export const RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS = 180_000
// Why: one retry covers a one-off stalled or aborted load; a second failure is the machine, not the load.
const RENDERER_RECOVERY_LOAD_ATTEMPTS = 2
// Why a cap: milestone kicks must not defer the verdict forever on a load that inches forward and never lands.
// It holds the same ~90s worst case as before, since only a load that reached a document can be kicked at all.
const RENDERER_RECOVERY_LOAD_CAP_FACTOR = 2

/** Automatic recovery vs the prompt's manual Reload; they must not share one breadcrumb name. */
export type RecoveryReloadTrigger = 'automatic' | 'manual-retry'

/** How far a load got. Ranked, so an attempt's milestone only ever moves forward. */
export type RecoveryReloadMilestone = 'none' | 'committed' | 'dom-ready'
const MILESTONE_RANK: Record<RecoveryReloadMilestone, number> = {
  none: 0,
  committed: 1,
  'dom-ready': 2
}

export type RecoveryExhaustionCause = 'crash-loop' | 'reload-stalled'

export type RendererRecoveryReloadWatchdog = {
  /** Issues a recovery reload and arms the stall watchdog. */
  issue: (
    details: Electron.RenderProcessGoneDetails,
    recentRecoveryCount: number,
    trigger?: RecoveryReloadTrigger
  ) => void
  /** Raises the recovery prompt at most once: a native message box cannot be dismissed, so a second one stacks. */
  escalate: (subject: RecoveryPromptSubject, cause: RecoveryExhaustionCause) => void
  /**
   * A main-frame document finished loading. Only an attempt whose load was superseded takes this as its outcome;
   * every other attempt settles through its own load promise, which an error page or a later navigation cannot fool.
   */
  notifyDocumentLoaded: () => void
  /** Restarts the stall budget after a suspend froze the timer mid-load. */
  notifySystemResume: () => void
  clear: () => void
}

type RecoveryReload = {
  attempt: number
  details: Electron.RenderProcessGoneDetails
  recentRecoveryCount: number
  /** Never rewritten: the elapsedMs a crash bundle reads has to stay time-since-issue. */
  issuedAt: number
  /** Absolute deadline. A suspend pushes it out; a milestone cannot. */
  capAt: number
  milestone: RecoveryReloadMilestone
  progressedSinceArm: boolean
  /** Chromium aborted this load for a later navigation, which now owns the outcome. */
  superseded: boolean
}

type RecoveryReloadSeed = Pick<RecoveryReload, 'attempt' | 'details' | 'recentRecoveryCount'>
/** What a raised prompt is about; the crash-loop breaker has no attempt to hand over, only the crash. */
export type RecoveryPromptSubject = Pick<RecoveryReload, 'details' | 'recentRecoveryCount'>

/**
 * Watches the automatic recovery reload for a load that never produces a document.
 *
 * The reload had no failure path at all: `loadFile`/`loadURL` rejections were discarded, no `did-fail-load`
 * listener existed, and the crash-loop breaker only counts renderer *deaths* — so a reload that silently never
 * lands never trips it and never reaches the recovery prompt. 62% of field bundles with a recovery reload end
 * exactly there: main process alive, renderer child spawned, no document, and a window the user force-quits.
 *
 * The verdict is deliberately one-sided. Nothing can cancel a pending Chromium load and nothing can dismiss a
 * native message box, so escalation keeps watching instead of forgetting: a load that lands late still records
 * the truth, and the prompt's Reload refuses to destroy a window that recovered behind the dialog.
 */
export function createRendererRecoveryReloadWatchdog(args: {
  /** True when a renderer death has already queued its own recovery, which then owns the next load. */
  isRecoveryPending: () => boolean
  isWindowClosing: () => boolean
  mainWindow: BrowserWindow
  opts?: CreateMainWindowOptions
  reloadMainWindow: (observer: MainWindowLoadObserver) => void
  rendererWebContentsId: number
}): RendererRecoveryReloadWatchdog {
  const {
    isRecoveryPending,
    isWindowClosing,
    mainWindow,
    opts,
    reloadMainWindow,
    rendererWebContentsId
  } = args
  // Why cached: `mainWindow.webContents` throws once the window is destroyed, and clear() runs during teardown.
  const rendererWebContents = mainWindow.webContents
  let inFlight: RecoveryReload | null = null
  // Why separate from inFlight: the most recent reload owns the document even after its budget ran out — a
  // late landing under the prompt is still the truth the bundle and the Reload button need.
  let latest: RecoveryReload | null = null
  // Why kept until the user answers: the box is undismissable, so while it is up no retry and no second prompt may
  // be raised — and the pending load is uncancellable, so a late landing still records against it.
  let prompt: RecoveryPromptSubject | null = null
  let documentLanded = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  // Why: mirrors loadMainWindow's dev/prod branch — a Vite-served document has a different honest budget.
  const timeoutMs = (): number =>
    is.dev && process.env.ELECTRON_RENDERER_URL
      ? RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS
      : RENDERER_RECOVERY_LOAD_TIMEOUT_MS

  const armTimer = (reload: RecoveryReload): void => {
    clearTimer()
    reload.progressedSinceArm = false
    timer = setTimeout(
      () => onBudgetExpired(reload),
      Math.max(0, Math.min(timeoutMs(), reload.capAt - Date.now()))
    )
    timer.unref?.()
  }

  const onBudgetExpired = (reload: RecoveryReload): void => {
    if (inFlight !== reload) {
      return
    }
    // Why: a load that reached a new milestone is progressing, and 'no did-finish-load yet' is not evidence of a
    // stall — aborting it here restarts a nearly-done load cold and can miss the budget it would have made.
    if (reload.progressedSinceArm && Date.now() < reload.capAt) {
      armTimer(reload)
      return
    }
    fail(reload)
  }

  const start = (seed: RecoveryReloadSeed, trigger: RecoveryReloadTrigger): void => {
    const issuedAt = Date.now()
    const reload: RecoveryReload = {
      ...seed,
      issuedAt,
      capAt: issuedAt + timeoutMs() * RENDERER_RECOVERY_LOAD_CAP_FACTOR,
      milestone: 'none',
      progressedSinceArm: false,
      superseded: false
    }
    inFlight = reload
    latest = reload
    documentLanded = false
    // Why: mark this in-place reload so the did-finish-load orphan sweep spares live PTYs until session restore (#5787).
    opts?.onBeforeRecoveryReload?.(mainWindow.webContents.id, trigger)
    // Why the promise and not did-finish-load: Electron resolves it for this load alone, rejects it when a later
    // navigation supersedes it, and rejects it for an error page — which still emits did-finish-load.
    reloadMainWindow({
      onLoaded: () => settleLoaded(reload),
      onError: (error) => onLoadRejected(reload, mainWindowLoadErrorCode(error))
    })
    armTimer(reload)
  }

  const settleLoaded = (reload: RecoveryReload): void => {
    // Why: a replaced attempt's promise can still resolve on the replacement's document.
    if (reload !== latest) {
      return
    }
    documentLanded = true
    if (reload === inFlight) {
      inFlight = null
      clearTimer()
    }
    opts?.onRecoveryReloadOutcome?.({
      status: 'loaded',
      attempt: reload.attempt,
      elapsedMs: Math.max(0, Date.now() - reload.issuedAt),
      // Why published: without it a bundle for a recovery that worked reads as exhausted, misleading triage
      // in exactly the way the paired-outcome crumb exists to prevent.
      ...(prompt ? { afterPrompt: true } : {}),
      // Why: elapsedMs then measures the replacement, not this reload; the budget analysis has to exclude it.
      ...(reload.superseded ? { superseded: true } : {})
    })
  }

  // Why ERR_ABORTED is never a verdict: Chromium aborts a load whenever something supersedes it — this watchdog's
  // own retry, a user navigation, a close race, another loadURL caller — and the replacement owns the outcome, so
  // failing here would raise the undismissable prompt over a window that is fine, and a cold retry would stomp the
  // load that replaced this one. Re-arming keeps the silence budget honest; capAt still bounds an abort that led
  // nowhere, so a load that truly goes dark still escalates on timeout.
  const onLoadRejected = (reload: RecoveryReload, errorCode: string): void => {
    if (errorCode !== 'ERR_ABORTED') {
      fail(reload, errorCode)
      return
    }
    if (inFlight === reload) {
      reload.superseded = true
      armTimer(reload)
    }
  }

  const retryFrom = (subject: RecoveryPromptSubject): void => {
    prompt = null
    // Why: no API dismisses a native message box, so a load that lands while the prompt is up leaves Reload aimed
    // at a healthy window; reloading it would destroy the session the recovery just restored.
    if (documentLanded) {
      return
    }
    start(
      { attempt: 1, details: subject.details, recentRecoveryCount: subject.recentRecoveryCount },
      'manual-retry'
    )
  }

  const escalate = (subject: RecoveryPromptSubject, cause: RecoveryExhaustionCause): void => {
    // Why reset first: whatever document last landed died with the renderer, so a Reload from the prompt already
    // up must not be declined as if the window were healthy.
    documentLanded = false
    if (prompt) {
      return
    }
    prompt = subject
    opts?.onRendererRecoveryExhausted?.({
      details: subject.details,
      webContentsId: rendererWebContentsId,
      recentRecoveryCount: subject.recentRecoveryCount,
      cause,
      // Why: the prompt's default button is Reload, and an unwatched retry drops the user back into the same
      // silent hang with no further prompt — the retry has to be watched or the remedy is one-shot.
      retry: () => retryFrom(subject)
    })
  }

  const fail = (reload: RecoveryReload, errorCode?: string): void => {
    // Why: a superseded attempt can still report late; only the live one owns the outcome.
    if (inFlight !== reload) {
      return
    }
    // Why before any mutation: teardown is not a verdict, so no modal is raised mid-shutdown. inFlight survives
    // the return, so a later resume or renderer death re-arms this attempt; nothing re-arms it here.
    if (
      isWindowClosing() ||
      opts?.getIsQuitting?.() ||
      mainWindow.isDestroyed() ||
      isSystemSessionEnding()
    ) {
      return
    }
    inFlight = null
    clearTimer()
    opts?.onRecoveryReloadOutcome?.({
      status: errorCode === undefined ? 'timeout' : 'failed',
      attempt: reload.attempt,
      // Why clamp: a backward wall-clock jump must not publish a negative duration into a crash bundle.
      elapsedMs: Math.max(0, Date.now() - reload.issuedAt),
      progress: reload.milestone,
      ...(errorCode === undefined ? {} : { errorCode })
    })
    // Why: a prompt already up owns the next load; a retry under it is a reload the user did not ask for, and a
    // second prompt would stack on the first.
    if (prompt || isRecoveryPending()) {
      return
    }
    // Why only a load that never reached a document: a cold retry is the remedy for a load that went nowhere,
    // and the wrong one for a document that parsed and then hung — that restart throws the work away.
    if (reload.attempt < RENDERER_RECOVERY_LOAD_ATTEMPTS && reload.milestone === 'none') {
      start({ ...reload, attempt: reload.attempt + 1 }, 'automatic')
      return
    }
    escalate(reload, 'reload-stalled')
  }

  // Why these two: they separate the field failure (renderer spawned, no document, ever) from a machine that is
  // merely slow — commit means the document arrived, dom-ready that it parsed. isLoadingMainFrame() cannot make
  // that call: it reads true for a stalled load and a progressing one alike.
  const observeMilestone = (milestone: RecoveryReloadMilestone) => (): void => {
    if (!inFlight || MILESTONE_RANK[milestone] <= MILESTONE_RANK[inFlight.milestone]) {
      return
    }
    inFlight.milestone = milestone
    inFlight.progressedSinceArm = true
  }
  const onDidNavigate = observeMilestone('committed')
  const onDomReady = observeMilestone('dom-ready')
  rendererWebContents.on('did-navigate', onDidNavigate)
  rendererWebContents.on('dom-ready', onDomReady)

  return {
    issue: (details, recentRecoveryCount, trigger = 'automatic') =>
      start({ attempt: 1, details, recentRecoveryCount }, trigger),
    escalate,
    notifyDocumentLoaded: () => {
      // Why latest, not inFlight: a superseded load whose cap already raised the prompt still recovers this way.
      if (latest?.superseded) {
        settleLoaded(latest)
      }
    },
    // Why: sleep freezes the timer, so it fires on wake against a load that never got its budget — and would
    // abort a healthy load, or across both attempts raise the dialog on a healthy machine. Move the deadline
    // only; issuedAt stays put so elapsedMs remains time-since-issue rather than time-since-last-resume.
    notifySystemResume: () => {
      if (!inFlight) {
        return
      }
      inFlight.capAt = Date.now() + timeoutMs() * RENDERER_RECOVERY_LOAD_CAP_FACTOR
      armTimer(inFlight)
    },
    clear: () => {
      inFlight = null
      latest = null
      prompt = null
      clearTimer()
      rendererWebContents.off?.('did-navigate', onDidNavigate)
      rendererWebContents.off?.('dom-ready', onDomReady)
    }
  }
}
