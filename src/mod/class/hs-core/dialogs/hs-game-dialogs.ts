import { HSLogger } from "../hs-logger";

export type HSDialogKind = 'confirm' | 'alert' | 'infoAlert' | 'prompt' | 'purchasePrompt';

/**
 * How a session answers each kind of dialog. A kind left out isn't claimed by the session.
 * 'show': the dialog is shown, and the feature fills or answers it through the DOM.
 */
export interface HSDialogAnswers {
    confirm?: 'ok' | 'cancel' | 'show';
    alert?: 'dismiss' | 'show';
    infoAlert?: 'dismiss' | 'show';
    prompt?: { ok: string } | 'cancel' | 'show';
    // The mod can't build a purchase quote: buying goes through the shown dialog
    purchasePrompt?: 'cancel' | 'show';
}

type HSDialogAnswer = NonNullable<HSDialogAnswers[HSDialogKind]>;

export interface HSDialogRunOptions {
    /** The lock is released and the session ended past this time (default 30 s). */
    timeLimitMs?: number;
    /** Goes ahead of the other sessions waiting for the lock (autosing). */
    priority?: boolean;
}

interface HSDialogOrigin {
    source: 'mod' | 'player' | 'game';
    session?: HSDialogSession;
    answers?: HSDialogAnswers;
}

/** A session's claim on the dialogs queued while it acts (see HSGameDialogs.#getOrigin). */
interface HSActWindow {
    session: HSDialogSession;
    answers: HSDialogAnswers;
    event: Event | undefined;
    running: boolean;
}

/**
 * A mod feature's turn with the game dialogs. Dialogs it queues while acting get its answers,
 * as long as the session hasn't ended when they reach the front of the queue (else they're orphans).
 */
export class HSDialogSession {
    readonly owner: string;
    #ended = false;

    constructor(owner: string) {
        this.owner = owner;
    }

    get ended(): boolean {
        return this.#ended;
    }

    /**
     * Runs fn (synchronous, e.g. a click on a game button) with these answers for the dialogs it queues.
     * @returns false if the session has ended: fn isn't run.
     */
    act(answers: HSDialogAnswers, fn: () => void): boolean {
        if (this.#ended) return false;
        HSGameDialogs.actFor(this, answers, fn);
        return true;
    }

    /** Called by HSGameDialogs only. */
    end(): void {
        this.#ended = true;
    }
}

/**
 * Class: HSGameDialogs
 * IsExplicitHSModule: No
 * Description:
 *     Shares the game's dialog queue (Confirm, Alert, InfoAlert, Prompt, PurchasePrompt) between mod features.
 *     With the patcher's dialog hook, each dialog's origin is recorded when it's queued (mod session, player,
 *     mod click, game), and the mod can answer it before it's shown. Without the hook (bookmarklet, older patcher),
 *     sessions answer their dialogs through the DOM.
 *     Features use act() for synchronous actions, and run() for longer ones: run() waits for an idle queue and
 *     holds a lock, so two features never interleave their dialogs.
 *     Design: docs/git-ignore/dialog-queue-design.md
 * Author: maenhiir
 */
export class HSGameDialogs {
    static #context = 'HSGameDialogs';
    static readonly DEFAULT_TIME_LIMIT_MS = 30000;

    static #initialized = false;
    static #hookPatched = false;
    static #box: HTMLElement | null = null;
    static #boxOpen = false;

    static #origins = new WeakSet<HSDialogOrigin>();
    static #gameOrigin: HSDialogOrigin = { source: 'game' };
    static #actWindows: HSActWindow[] = [];
    // The dialog shown right now (hook mode), and the last one answered or closed in the current task
    static #shown: HSDialogOrigin | null = null;
    static #lastClosed: HSDialogOrigin | null = null;
    static #taskEndChannel: MessageChannel | null = null;
    static #taskEndPending = false;

    static #lockHolder: HSDialogSession | null = null;
    static #waiters: { priority: boolean, grant: () => void }[] = [];

    static #domIds: Record<HSDialogKind, { wrapper: string, ok: string, cancel?: string }> = {
        confirm: { wrapper: 'confirmWrapper', ok: 'ok_confirm', cancel: 'cancel_confirm' },
        alert: { wrapper: 'alertWrapper', ok: 'ok_alert' },
        infoAlert: { wrapper: 'infoAlertWrapper', ok: 'ok_infoAlert' },
        prompt: { wrapper: 'promptWrapper', ok: 'ok_prompt', cancel: 'cancel_prompt' },
        purchasePrompt: { wrapper: 'purchasePromptWrapper', ok: 'ok_purchasePrompt', cancel: 'cancel_purchasePrompt' },
    };

    /** Installs the hook's callbacks and the queue observer. Needs the game's DOM. */
    static init(): void {
        if (HSGameDialogs.#initialized) return;
        HSGameDialogs.#initialized = true;

        HSGameDialogs.#hookPatched = !!(window as any).__HS_DIALOG_HOOK_PATCHED;
        (window as any).__HS_dialogOrigin = (kind: HSDialogKind) => HSGameDialogs.#getOrigin(kind);
        (window as any).__HS_onDialog = (kind: HSDialogKind, origin: unknown) => HSGameDialogs.#onDialog(kind, origin);

        HSGameDialogs.#box = document.getElementById('confirmationBox');
        if (HSGameDialogs.#box) {
            HSGameDialogs.#boxOpen = !HSGameDialogs.isQueueIdle();
            new MutationObserver(() => HSGameDialogs.#onBoxMutation())
                .observe(HSGameDialogs.#box, { attributes: true, attributeFilter: ['style'] });
        } else {
            HSLogger.warn('#confirmationBox not found: the queue is always seen as idle', HSGameDialogs.#context);
        }

        if (HSGameDialogs.#hookPatched) {
            HSLogger.log('Game dialog hook available', HSGameDialogs.#context);
        } else {
            HSLogger.warn('Game dialog hook not patched: mod features answer their dialogs through the DOM', HSGameDialogs.#context);
        }
    }

    static isHookPatched(): boolean {
        return HSGameDialogs.#hookPatched;
    }

    /**
     * No dialog is open. Every queued dialog is shown inside #confirmationBox, so a hidden box means an empty queue.
     * Reads the real inline value: HSUtils.hiddenAction() fakes style.display while it runs.
     */
    static isQueueIdle(): boolean {
        return HSGameDialogs.#box?.style.getPropertyValue('display') !== 'block';
    }

    /**
     * For synchronous actions: runs fn with these answers for the dialogs it queues.
     * Its dialogs still waiting in the queue after the default time limit are orphans.
     */
    static act(owner: string, answers: HSDialogAnswers, fn: () => void): void {
        const session = new HSDialogSession(owner);
        window.setTimeout(() => session.end(), HSGameDialogs.DEFAULT_TIME_LIMIT_MS);
        HSGameDialogs.actFor(session, answers, fn);
    }

    /**
     * For longer actions: waits for the lock and an idle queue, then runs fn holding the lock.
     * Inside, the feature calls s.act() for each step. The lock is never held while waiting for the player:
     * it's taken only once the queue is idle. Past the time limit, the session ends (s.ended, s.act() refuses),
     * the lock is released and its dialogs still queued become orphans; fn should then stop.
     */
    static async run<T>(owner: string, options: HSDialogRunOptions, fn: (s: HSDialogSession) => Promise<T>): Promise<T> {
        const session = new HSDialogSession(owner);
        await new Promise<void>(resolve => {
            HSGameDialogs.#waiters.push({
                priority: !!options.priority,
                grant: () => { HSGameDialogs.#lockHolder = session; resolve(); }
            });
            HSGameDialogs.#pump();
        });

        const timeLimitMs = options.timeLimitMs ?? HSGameDialogs.DEFAULT_TIME_LIMIT_MS;
        const timer = window.setTimeout(() => {
            HSLogger.warn(`${owner} still holds the dialog lock after ${timeLimitMs} ms: released`, HSGameDialogs.#context);
            HSGameDialogs.#endSession(session);
        }, timeLimitMs);
        try {
            return await fn(session);
        } finally {
            window.clearTimeout(timer);
            HSGameDialogs.#endSession(session);
        }
    }

    /** Used by HSDialogSession.act(). */
    static actFor(session: HSDialogSession, answers: HSDialogAnswers, fn: () => void): void {
        // Kept until the end of the task: dialogs chained after an await (e.g. an Alert after a Confirm or a
        // PurchasePrompt) are queued in a later microtask. Within the same event only: when a player's click
        // runs this, the chained dialog still sees that click as window.event.
        const actWindow: HSActWindow = { session, answers, event: window.event, running: true };
        HSGameDialogs.#actWindows.push(actWindow);
        HSGameDialogs.#scheduleTaskEnd();
        try {
            fn();
        } finally {
            actWindow.running = false;
        }
    }

    // ── Origins and answers (called by the patched game code) ────────────────────────────────────────

    /**
     * Called when a dialog is queued. In this order:
     * 1. a session acting right now, or earlier in the same task and event, that claims this kind
     * 2. a click or key press being handled: the player's (trusted) or a click made by code (mod)
     * 3. a dialog answered or closed earlier in the same task: the next dialog of its chain, same origin
     * 4. otherwise the game (timer, network, async chains like a file import)
     */
    static #getOrigin(kind: HSDialogKind): HSDialogOrigin | undefined {
        try {
            const event = window.event;
            const claim = HSGameDialogs.#findClaim(kind, event);
            let origin: HSDialogOrigin;
            if (claim) {
                origin = { source: 'mod', session: claim.session, answers: claim.answers };
            } else if (event) {
                origin = { source: event.isTrusted ? 'player' : 'mod' };
            } else if (HSGameDialogs.#lastClosed) {
                const previous = HSGameDialogs.#lastClosed;
                origin = previous.session && previous.answers?.[kind] !== undefined
                    ? { source: 'mod', session: previous.session, answers: previous.answers }
                    : { source: previous.source };
            } else {
                origin = { source: 'game' };
            }
            HSGameDialogs.#origins.add(origin);
            return origin;
        } catch (error) {
            HSLogger.warn(`Dialog origin failed: ${error}`, HSGameDialogs.#context);
            return undefined;
        }
    }

    static #findClaim(kind: HSDialogKind, event: Event | undefined): HSActWindow | undefined {
        const windows = HSGameDialogs.#actWindows;
        for (let i = windows.length - 1; i >= 0; i--) {
            const actWindow = windows[i];
            if (actWindow.answers[kind] === undefined) continue;
            if (actWindow.running || actWindow.event === event) return actWindow;
        }
        return undefined;
    }

    /**
     * Called when a dialog reaches the front of the queue.
     * @returns { value } to resolve the dialog without showing it, undefined to show it.
     */
    static #onDialog(kind: HSDialogKind, rawOrigin: unknown): { value: unknown } | undefined {
        try {
            // A missing or foreign origin (dialog queued before the mod loaded): the game's
            const origin = HSGameDialogs.#origins.has(rawOrigin as HSDialogOrigin)
                ? rawOrigin as HSDialogOrigin
                : HSGameDialogs.#gameOrigin;

            let answer: HSDialogAnswer | undefined;
            if (origin.session) {
                if (origin.session.ended) {
                    answer = HSGameDialogs.#orphanAnswer(kind);
                    HSLogger.log(`Orphan ${kind} of ${origin.session.owner}: answered "${HSGameDialogs.#describe(answer)}"`, HSGameDialogs.#context);
                } else {
                    answer = origin.answers?.[kind];
                }
            } else if ((window as any).__HS_AUTO_CONFIRM === true && (kind === 'confirm' || kind === 'alert')) {
                // Today's auto-confirm (autosing), whatever the origin. Replaced by an origin-based policy in step 2.
                answer = kind === 'confirm' ? 'ok' : 'dismiss';
            }

            if (answer === undefined || answer === 'show') {
                HSGameDialogs.#shown = origin;
                return undefined;
            }
            HSGameDialogs.#setLastClosed(origin);
            return { value: HSGameDialogs.#toValue(kind, answer) };
        } catch (error) {
            HSLogger.warn(`Dialog hook failed, dialog shown: ${error}`, HSGameDialogs.#context);
            return undefined;
        }
    }

    static #orphanAnswer(kind: HSDialogKind): HSDialogAnswer {
        return kind === 'alert' || kind === 'infoAlert' ? 'dismiss' : 'cancel';
    }

    /** The value the game's dialog promise resolves to. */
    static #toValue(kind: HSDialogKind, answer: HSDialogAnswer): unknown {
        if (typeof answer === 'object') return answer.ok;
        if (answer === 'ok') return true;
        if (answer === 'cancel') return kind === 'confirm' ? false : null;
        return undefined;
    }

    static #describe(answer: HSDialogAnswer): string {
        return typeof answer === 'object' ? `ok: ${answer.ok}` : answer;
    }

    // ── Task scope ───────────────────────────────────────────────────────────────────────────────────

    static #setLastClosed(origin: HSDialogOrigin): void {
        HSGameDialogs.#lastClosed = origin;
        HSGameDialogs.#scheduleTaskEnd();
    }

    /**
     * Clears the act windows and the last closed dialog once the current task has ended. One message for all:
     * when it's delivered, every task that set them has finished (tasks don't interleave, microtasks run first).
     */
    static #scheduleTaskEnd(): void {
        if (HSGameDialogs.#taskEndPending) return;
        HSGameDialogs.#taskEndPending = true;
        if (!HSGameDialogs.#taskEndChannel) {
            HSGameDialogs.#taskEndChannel = new MessageChannel();
            HSGameDialogs.#taskEndChannel.port1.onmessage = () => {
                HSGameDialogs.#taskEndPending = false;
                HSGameDialogs.#actWindows = HSGameDialogs.#actWindows.filter(actWindow => actWindow.running);
                HSGameDialogs.#lastClosed = null;
            };
        }
        HSGameDialogs.#taskEndChannel.port2.postMessage(null);
    }

    // ── Queue observer ───────────────────────────────────────────────────────────────────────────────

    /**
     * Runs when #confirmationBox's style changes, i.e. a dialog is shown or closed. Answered dialogs never
     * show it. Runs as a microtask queued by the close itself, so before the game's code chained after it.
     */
    static #onBoxMutation(): void {
        const open = !HSGameDialogs.isQueueIdle();
        if (open === HSGameDialogs.#boxOpen) return;
        HSGameDialogs.#boxOpen = open;

        if (open) {
            if (!HSGameDialogs.#hookPatched) HSGameDialogs.#answerShownByDom();
            return;
        }
        if (HSGameDialogs.#shown) {
            HSGameDialogs.#setLastClosed(HSGameDialogs.#shown);
            HSGameDialogs.#shown = null;
        }
        // One step later: the next queued dialog (or the next one of a chain) may open right after this one closed
        window.setTimeout(() => HSGameDialogs.#pump(), 0);
    }

    /** Without the hook: a session answers its dialog through the DOM once it's shown. */
    static #answerShownByDom(): void {
        const kind = (Object.keys(HSGameDialogs.#domIds) as HSDialogKind[])
            .find(k => document.getElementById(HSGameDialogs.#domIds[k].wrapper)?.style.display === 'block');
        if (!kind) return;
        const claim = HSGameDialogs.#findClaim(kind, window.event);
        if (!claim) return;
        const answer = claim.answers[kind];
        if (answer === undefined || answer === 'show') return;

        const ids = HSGameDialogs.#domIds[kind];
        if (typeof answer === 'object') {
            const input = document.getElementById('prompt_text') as HTMLInputElement | null;
            if (input) input.value = answer.ok;
        }
        const buttonId = answer === 'cancel' ? ids.cancel : ids.ok;
        if (buttonId) (document.getElementById(buttonId) as HTMLButtonElement | null)?.click();
    }

    // ── Lock ─────────────────────────────────────────────────────────────────────────────────────────

    /** Gives the lock to the next waiter (priority first) when it's free and the queue is idle. */
    static #pump(): void {
        if (HSGameDialogs.#lockHolder || HSGameDialogs.#waiters.length === 0 || !HSGameDialogs.isQueueIdle()) return;
        const priorityIndex = HSGameDialogs.#waiters.findIndex(waiter => waiter.priority);
        const [waiter] = HSGameDialogs.#waiters.splice(priorityIndex >= 0 ? priorityIndex : 0, 1);
        waiter.grant();
    }

    static #endSession(session: HSDialogSession): void {
        if (session.ended) return;
        session.end();
        if (HSGameDialogs.#lockHolder === session) {
            HSGameDialogs.#lockHolder = null;
            HSGameDialogs.#pump();
        }
    }
}
